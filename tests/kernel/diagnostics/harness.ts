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
import { spawnBounded } from "../kernel-repair/swarm-process.ts";

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
  readonly dir: string;
};

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
  readonly signalCode: NodeJS.Signals | number | null;
}[] = [];

// Platform: SIGKILL, because a CLI blocked in a synchronous system call (a failing FIFO
// control) cannot run its SIGTERM handler.
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
  readonly signal: NodeJS.Signals | number | null;
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
  readonly fault?: string | undefined;
  readonly umask?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: string;
  // Platform: Bun's own spawn pipe is drained eagerly, so only a relay that does not
  // read gives the CLI real backpressure (it waits in drain past the pipe
  // buffer).
  readonly holdStdoutUntil?: string;
};

function environment(launch: Launch): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: launch.tree.root,
    // Platform: Bun's own transpiler cache would otherwise write under HOME, which
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

function command(launch: Launch): string[] {
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
  return launch.holdStdoutUntil === undefined
    ? direct
    : ["/usr/bin/perl", "-e", stdoutRelay, launch.holdStdoutUntil, ...direct];
}

function envelopeOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

export function start(launch: Launch) {
  const began = performance.now();
  const child = Bun.spawn({
    cmd: command(launch),
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
    return {
      stdout,
      stderr,
      exit,
      signal: child.signalCode,
      elapsedMilliseconds: performance.now() - began,
      envelope: envelopeOf(stdout),
    };
  })();
  return { child, finished };
}

export function run(launch: Launch): Promise<Run> {
  return start(launch).finished;
}

// Platform: a CLI that calls abort() exits only after the host has dealt with
// the aborted process. Hosted ubuntu runners took 17,769 ms to 27,337 ms for
// D15.crash-cannot-pass and D17.crash-no-status alone (runs 44220059795,
// 44228141798, 44231023432), and 57,917 ms, 59,780 ms and more than
// 60,000 ms when R2's child aborted at the same time (run 44231300109
// attempt 1, run 44231023432 attempts 2 and 1); Darwin and Linux containers
// take milliseconds.
const overlappingAbortMilliseconds = 60_000;
export const crashExitBound = 2 * overlappingAbortMilliseconds;
export const teardownMargin = 15_000;
export const crashTimeout = crashExitBound + teardownMargin;
export async function runCrash(
  launch: Launch,
  boundMilliseconds = crashExitBound,
): Promise<Run> {
  const began = performance.now();
  const { stdout, stderr, exit, signal } = await spawnBounded(command(launch), {
    env: environment(launch),
    boundMilliseconds,
    processGroup: true,
  });
  return {
    stdout,
    stderr,
    exit,
    signal: signal ?? null,
    elapsedMilliseconds: performance.now() - began,
    envelope: envelopeOf(stdout),
  };
}

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
