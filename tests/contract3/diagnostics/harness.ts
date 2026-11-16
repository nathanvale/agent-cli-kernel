// Process test harness for the T5 diagnostics cases. It runs the labelled
// specimen CLIs as real child processes against a test-owned HOME and
// XDG_STATE_HOME tree and observes raw stdout/stderr bytes, the real exit and
// the diagnostics directory through its own reader (lstat, modes, inodes,
// bytes). It never imports the diagnostics add-on: expected values come from
// t5-cases.json, the contract and the diagnostics-intact twin.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const specimenCli = join(here, "fixtures/specimen-cli.ts");
const bareCli = join(here, "fixtures/bare-cli.ts");
const cli = "dxs";

const frozen: unknown = JSON.parse(
  readFileSync(join(here, "t5-cases.json"), "utf8"),
);
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}
function numberField(value: unknown, key: string): number {
  const found = field(value, key);
  if (typeof found !== "number")
    throw new Error(`Frozen limit ${key} missing.`);
  return found;
}
// DIAG-9 limits as frozen in t5-cases.json (copied from the oracle).
const frozenLimits = field(frozen, "limits");
export const limits = {
  aggregateBytes: numberField(frozenLimits, "aggregateBytes"),
  perRunBytes: numberField(frozenLimits, "perRunBytes"),
  files: numberField(frozenLimits, "files"),
  bufferBytes: numberField(frozenLimits, "bufferBytes"),
  bufferRecords: numberField(frozenLimits, "bufferRecords"),
  recordBytes: numberField(frozenLimits, "recordBytes"),
  flushMilliseconds: numberField(frozenLimits, "flushMilliseconds"),
  pruneClosedOlderThanDays: numberField(
    frozenLimits,
    "pruneClosedOlderThanDays",
  ),
} as const;

const roots: string[] = [];
export type Tree = {
  readonly root: string;
  readonly home: string;
  readonly state: string;
  // The diagnostics directory under XDG_STATE_HOME.
  readonly dir: string;
};

// A fresh test-owned tree. Real path, so reported paths compare as strings.
export function tree(): Tree {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "t5-diag-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const state = join(root, "state");
  return { root, home, state, dir: join(state, cli, "diagnostics") };
}

const children: {
  readonly kill: (signal?: number | NodeJS.Signals) => void;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}[] = [];

// Teardown: kill every child this harness started that is still running,
// then remove the trees. SIGKILL, because a CLI blocked in a synchronous
// system call (a failing FIFO control) cannot run its SIGTERM handler.
export function cleanTrees(): void {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
}

export type Run = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number | null;
  readonly signal: string | null;
  readonly elapsedMilliseconds: number;
  readonly envelope: unknown;
};

export type Launch = {
  readonly argv: readonly string[];
  readonly tree: Tree;
  readonly xdg?: boolean;
  readonly home?: boolean;
  readonly bare?: boolean;
  readonly script?: Readonly<Record<string, unknown>>;
  readonly fault?: string;
  readonly umask?: string;
  readonly env?: Readonly<Record<string, string>>;
  // A bash command line; "$@" is the runtime and the specimen.
  readonly shell?: string;
  // Hold the CLI's stdout in an unread OS pipe until this file exists. Bun's
  // own spawn pipe is drained eagerly, so only a relay that does not read
  // gives the CLI real backpressure (it waits in drain past the pipe buffer).
  readonly holdStdoutUntil?: string;
};

function environment(launch: Launch): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: launch.tree.root,
    // Bun's own transpiler cache would otherwise write under HOME, which
    // would hide what the CLI itself creates there.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    DXS_SCRIPT: JSON.stringify(launch.script ?? {}),
    ...launch.env,
  };
  if (launch.home !== false) env.HOME = launch.tree.home;
  if (launch.xdg !== false) env.XDG_STATE_HOME = launch.tree.state;
  if (launch.fault !== undefined) env.DXS_FAULT = launch.fault;
  return env;
}

// Runs ARGV[1..] with stdout on a fresh OS pipe that is not read until the
// file ARGV[0] exists (60 s deadline), then relays it and exits with the
// child's code.
const stdoutRelay = [
  "my $release = shift @ARGV;",
  "pipe(my $r, my $w) or die 'pipe';",
  "my $pid = fork() // die 'fork';",
  "if ($pid == 0) { close $r; open(STDOUT, '>&', $w) or die 'dup'; close $w; exec { $ARGV[0] } @ARGV or die 'exec'; }",
  "close $w;",
  "my $until = time + 60;",
  "select(undef, undef, undef, 0.005) until -e $release || time > $until;",
  "binmode $r; binmode STDOUT; my $buffer;",
  "while (my $n = sysread($r, $buffer, 65536)) { syswrite(STDOUT, $buffer, $n); }",
  "waitpid($pid, 0); exit($? >> 8);",
].join("\n");

export function start(launch: Launch) {
  const file = launch.bare ? bareCli : specimenCli;
  const direct =
    launch.shell !== undefined
      ? ["/bin/bash", "-c", launch.shell, "bash", process.execPath, file]
      : launch.umask === undefined
        ? [process.execPath, file, ...launch.argv]
        : [
            "/bin/sh",
            "-c",
            `umask ${launch.umask}; exec "$0" "$@"`,
            process.execPath,
            file,
            ...launch.argv,
          ];
  const cmd =
    launch.holdStdoutUntil === undefined
      ? direct
      : ["/usr/bin/perl", "-e", stdoutRelay, launch.holdStdoutUntil, ...direct];
  const began = performance.now();
  const child = Bun.spawn({
    cmd,
    env: environment(launch),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const finished = (async (): Promise<Run> => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const exit = await child.exited;
    const elapsedMilliseconds = performance.now() - began;
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      envelope = undefined;
    }
    return {
      stdout,
      stderr,
      exit,
      signal: child.signalCode,
      elapsedMilliseconds,
      envelope,
    };
  })();
  return { child, finished };
}

export function run(launch: Launch): Promise<Run> {
  return start(launch).finished;
}

// Canon (DIAG-16): only diagnostics, run identity and genuine time are
// normalised. message, data, effects, cause, exit and guidance never are.
export function canon(envelope: unknown): string {
  if (typeof envelope !== "object" || envelope === null)
    return JSON.stringify(envelope);
  const copy: Record<string, unknown> = { ...envelope };
  delete copy.diagnostics;
  const result = copy.result;
  if (typeof result === "object" && result !== null)
    copy.result = { ...result, runId: "<run>" };
  return JSON.stringify(copy);
}

export type Observed = {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "fifo" | "other";
  readonly mode: number;
  readonly size: number;
  readonly ino: number;
  readonly mtimeMs: number;
};
export type DirectoryView = {
  readonly exists: boolean;
  readonly kind?: Observed["kind"];
  readonly mode?: number;
  readonly entries: readonly Observed[];
  readonly files: readonly Observed[];
  readonly fileBytes: number;
};

function kind(path: string): Observed["kind"] {
  return kindOf(lstatSync(path));
}
function kindOf(info: import("node:fs").Stats): Observed["kind"] {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isFIFO()) return "fifo";
  return "other";
}

// The independent reader: what is actually on disk, by lstat.
export function observe(dir: string): DirectoryView {
  if (!existsSync(dir) && !isLink(dir))
    return { exists: false, entries: [], files: [], fileBytes: 0 };
  const info = lstatSync(dir);
  const dirKind = kind(dir);
  if (dirKind !== "directory")
    return {
      exists: true,
      kind: dirKind,
      mode: info.mode & 0o7777,
      entries: [],
      files: [],
      fileBytes: 0,
    };
  // An entry removed between listing and lstat (a concurrent prune) is
  // simply no longer there.
  const entries = readdirSync(dir).flatMap((name): Observed[] => {
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      return [
        {
          name,
          path,
          kind: kindOf(stat),
          mode: stat.mode & 0o7777,
          size: stat.size,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
        },
      ];
    } catch {
      return [];
    }
  });
  const files = entries.filter((entry) => entry.kind === "file");
  return {
    exists: true,
    kind: dirKind,
    mode: info.mode & 0o7777,
    entries,
    files,
    fileBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function lines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}

export async function waitForFile(path: string, timeoutMilliseconds = 30_000) {
  const until = performance.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (performance.now() > until)
      throw new Error(`Barrier ${path} never reached.`);
    await Bun.sleep(2);
  }
}

// Barrier on an observable condition: the run's log exists in `dir`.
export async function waitForLog(dir: string, timeoutMilliseconds = 30_000) {
  const until = performance.now() + timeoutMilliseconds;
  while (!observe(dir).files.some((entry) => entry.name.endsWith(".jsonl"))) {
    if (performance.now() > until)
      throw new Error(`No log appeared in ${dir}.`);
    await Bun.sleep(2);
  }
}

export function open(path: string): void {
  writeFileSync(path, "go");
}

export function get(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = field(current, key);
  return current;
}
