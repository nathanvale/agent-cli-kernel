import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { record } from "../../../kernel/src/kernel/validation/primitives.ts";
import { signalGroupIfPresent, signalIfPresent } from "../../support/signal.ts";

const here = import.meta.dir;
const repository = resolve(here, "../../..");
const faultCli = join(here, "fixtures/fault-cli.ts");
export const canaryCli = join(here, "fixtures/canary-cli.ts");
export const decliningHost = join(here, "fixtures/declining-host.ts");

export type Expectation = Readonly<Record<string, unknown>>;
export type Case = {
  readonly id: string;
  readonly family: string;
  readonly status: string;
  readonly argv: readonly string[];
  readonly scenario: string | undefined;
  readonly state: boolean;
  readonly stdin: "closed" | "held-open";
  readonly expect: Expectation;
  readonly supplier: string | undefined;
  readonly note: string | undefined;
};
export type Row = {
  readonly outcome: string;
  readonly transactionState: string;
  readonly failureClass: string | null;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly guidance: string;
};

const frozen: unknown = JSON.parse(
  readFileSync(join(here, "t2-cases.json"), "utf8"),
);

function field(value: unknown, key: string): unknown {
  return record(value) ? value[key] : undefined;
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.map((entry) => {
        if (typeof entry !== "string") throw new Error("Expected strings.");
        return entry;
      })
    : [];
}
function expectation(value: unknown): Expectation {
  return record(value) ? value : {};
}

export const allCases: readonly Case[] = (() => {
  const list = field(frozen, "cases");
  if (!Array.isArray(list)) throw new Error("Frozen case file has no cases.");
  return list.map((entry: unknown) => {
    const id = field(entry, "id");
    const family = field(entry, "family");
    const status = field(entry, "status");
    const scenario = field(entry, "scenario");
    const supplier = field(entry, "supplier");
    const note = field(entry, "note");
    if (
      typeof id !== "string" ||
      typeof family !== "string" ||
      typeof status !== "string"
    )
      throw new Error("Malformed frozen case.");
    return {
      id,
      family,
      status,
      argv: strings(field(entry, "argv")),
      scenario: typeof scenario === "string" ? scenario : undefined,
      state: field(entry, "state") === true,
      stdin: field(entry, "stdin") === "held-open" ? "held-open" : "closed",
      expect: expectation(field(entry, "expect")),
      supplier: typeof supplier === "string" ? supplier : undefined,
      note: typeof note === "string" ? note : undefined,
    };
  });
})();

export function n(value: unknown): number {
  if (typeof value !== "number") throw new Error("Expected a frozen number.");
  return value;
}

export function caseById(id: string): Case {
  const found = allCases.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown frozen case ${id}.`);
  return found;
}

export function expectedRow(causeCode: string): Row {
  const row =
    field(field(frozen, "oracleCauses"), causeCode) ??
    field(field(frozen, "fixtureCauses"), causeCode);
  const outcome = field(row, "outcome");
  const transactionState = field(row, "transactionState");
  const failureClass = field(row, "failureClass");
  const exitCode = field(row, "exitCode");
  const retryable = field(row, "retryable");
  const guidance = field(row, "guidance");
  if (
    typeof outcome !== "string" ||
    typeof transactionState !== "string" ||
    !(failureClass === null || typeof failureClass === "string") ||
    typeof exitCode !== "number" ||
    typeof retryable !== "boolean" ||
    typeof guidance !== "string"
  )
    throw new Error(`No independent row for ${causeCode}.`);
  return {
    outcome,
    transactionState,
    failureClass,
    exitCode,
    retryable,
    guidance,
  };
}

export type Reader =
  | "normal"
  | "pause-after-first"
  | "closed-at-start"
  | "close-after-first-chunk"
  | "close-after-envelope";

export type Observed = {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutComplete: boolean;
  readonly stderrComplete: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | number | null;
  readonly pid: number;
  readonly spawnedAt: number;
  readonly exitedAt: number;
  readonly firstStdoutAt: number | undefined;
  readonly ledger: readonly string[];
  readonly dir: string;
  readonly operand?: OperandFit | undefined;
};
export type OperandFit = {
  readonly frozenLength: number;
  readonly refusedLength: number | null;
  readonly shortestRefusedLength: number | null;
  readonly exercisedLength: number;
};

export type Launched = {
  readonly pid: number;
  readonly running: () => boolean;
  readonly operand: OperandFit | undefined;
  readonly dir: string;
  readonly ledgerPath: string;
  readonly spawnedAt: number;
  readonly signal: (name: "SIGINT" | "SIGTERM" | "SIGKILL") => number;
  readonly barrier: (prefix: string, milliseconds?: number) => Promise<number>;
  readonly partialRead: Promise<number>;
  readonly done: Promise<Observed>;
};

export function readLedger(path: string): readonly string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
}

async function materialiseStateEntry(dir: string): Promise<string> {
  const target = join(dir, "kernel/src/addons/state");
  await mkdir(target, { recursive: true });
  const entry = join(target, "fx-state-entry.ts");
  const template = readFileSync(
    join(here, "fixtures/state-entry.ts.txt"),
    "utf8",
  )
    .replace("__KERNEL_INDEX__", join(repository, "kernel/src/kernel/index.ts"))
    .replace("__FAULT_CLI__", faultCli);
  await writeFile(entry, template);
  return entry;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const streamWait = 2_000;
function incomplete(stream: string): Error {
  return new Error(
    `UNPROVED: ${stream} was still open ${streamWait} ms after the CLI exited.`,
  );
}

const heldBytes = new TextEncoder().encode("FX-HELD-STDIN-BYTES\n".repeat(64));

export async function launch(options: {
  readonly argv: readonly string[];
  readonly state?: boolean;
  readonly scenario?: string | undefined;
  readonly stdin?: "closed" | "held-open";
  readonly reader?: Reader;
  readonly env?: Readonly<Record<string, string>>;
  readonly rawArgvShell?: string;
  readonly script?: string;
  readonly fitOperand?: number;
}): Promise<Launched> {
  requireTools();
  const dir = await mkdtemp(join(tmpdir(), "kernel-t2-"));
  const ledgerPath = join(dir, "ledger");
  const work = join(dir, "work");
  const temp = join(dir, "tmp");
  await mkdir(work);
  await mkdir(temp);
  const entry =
    options.script ??
    (options.state ? await materialiseStateEntry(dir) : faultCli);
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? dir,
    TMPDIR: temp,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    FX_LEDGER: ledgerPath,
    FX_SCENARIO: options.scenario ?? "",
    ...options.env,
  };
  const fitted =
    options.fitOperand === undefined
      ? undefined
      : fitOperand(
          [process.execPath, entry],
          options.argv,
          options.fitOperand,
          env,
        );
  const argv = fitted?.argv ?? options.argv;
  const command = options.rawArgvShell
    ? ["/bin/sh", "-c", options.rawArgvShell, process.execPath, entry]
    : [process.execPath, entry, ...argv];
  const spawnedAt = Date.now();
  const child = Bun.spawn(command, {
    cwd: work,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  if (options.stdin === "held-open") {
    void child.stdin.write(heldBytes);
    void child.stdin.flush();
  } else void child.stdin.end();

  const reader = options.reader ?? "normal";
  const chunks: Uint8Array[] = [];
  let firstStdoutAt: number | undefined;
  let markPartial: (at: number) => void = () => undefined;
  const partialRead = new Promise<number>((resolvePartial) => {
    markPartial = resolvePartial;
  });
  const stdoutDone = (async () => {
    const stream = child.stdout.getReader();
    if (reader === "closed-at-start") {
      await stream.cancel();
      return;
    }
    for (;;) {
      const next = await stream.read();
      if (next.done) return;
      firstStdoutAt ??= Date.now();
      chunks.push(next.value);
      if (reader === "pause-after-first") {
        markPartial(Date.now());
        return;
      }
      if (reader === "close-after-first-chunk") {
        await stream.cancel();
        return;
      }
      if (reader === "close-after-envelope" && next.value.includes(10)) {
        await stream.cancel();
        await writeFile(`${ledgerPath}.release`, "release");
        return;
      }
    }
  })();
  const stderrDone = new Response(child.stderr).arrayBuffer();
  const done = (async (): Promise<Observed> => {
    await child.exited;
    const exitedAt = Date.now();
    const [stdoutComplete, stderrRead] = await Promise.all([
      Promise.race([
        stdoutDone.then(() => true),
        Bun.sleep(streamWait).then(() => false),
      ]),
      Promise.race([stderrDone, Bun.sleep(streamWait).then(() => undefined)]),
    ]);
    if (options.stdin === "held-open") void child.stdin.end();
    const stdout = concat(chunks);
    const stderr = new Uint8Array(stderrRead ?? new ArrayBuffer(0));
    const stderrComplete = stderrRead !== undefined;
    return {
      get stdout() {
        if (!stdoutComplete) throw incomplete("stdout");
        return stdout;
      },
      get stderr() {
        if (!stderrComplete) throw incomplete("stderr");
        return stderr;
      },
      stdoutComplete,
      stderrComplete,
      code: child.signalCode ? null : child.exitCode,
      signal: child.signalCode,
      pid: child.pid,
      spawnedAt,
      exitedAt,
      firstStdoutAt,
      ledger: readLedger(ledgerPath),
      dir,
      operand: fitted?.fit,
    };
  })();
  return {
    pid: child.pid,
    running: () => child.exitCode === null && child.signalCode === null,
    operand: fitted?.fit,
    dir,
    ledgerPath,
    spawnedAt,
    signal(name) {
      child.kill(name);
      return Date.now();
    },
    async barrier(prefix, milliseconds = 10_000) {
      const until = Date.now() + milliseconds;
      while (Date.now() < until) {
        if (readLedger(ledgerPath).some((line) => line.startsWith(prefix)))
          return Date.now();
        await Bun.sleep(2);
      }
      throw new Error(`Barrier ${prefix} not reached: case unproved.`);
    },
    partialRead,
    done,
  };
}

export async function cleanup(observed: { readonly dir: string }) {
  await rm(observed.dir, { recursive: true, force: true });
}

const toolBound = 5_000;

// Platform: H1: whether the host will start a process with this exact argv and
// environment. Linux refuses any single argument of 131,072 bytes or more
// (MAX_ARG_STRLEN, terminator included); Darwin limits only the total
// (ARG_MAX). The probe runs /bin/sh with the same arguments and environment
// plus three short tokens, so a length that fits here fits the real spawn.
function spawns(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): boolean {
  let probe: ReturnType<typeof Bun.spawnSync>;
  try {
    probe = Bun.spawnSync(["/bin/sh", "-c", ":", ...argv], {
      env,
      stdout: "ignore",
      stderr: "ignore",
      timeout: toolBound,
      killSignal: "SIGKILL",
    });
  } catch {
    return false;
  }
  if (probe.exitedDueToTimeout === true)
    throw new Error(`/bin/sh -c : did not finish within ${toolBound} ms.`);
  return probe.success;
}

export function spawnableLength(
  build: (length: number) => readonly string[],
  env: Readonly<Record<string, string>>,
  wanted: number,
): number {
  if (spawns(build(wanted), env)) return wanted;
  let fits = 0;
  let refused = wanted;
  while (refused - fits > 1) {
    const middle = Math.floor((fits + refused) / 2);
    if (spawns(build(middle), env)) fits = middle;
    else refused = middle;
  }
  return fits;
}

function fitOperand(
  prefix: readonly string[],
  argv: readonly string[],
  index: number,
  env: Readonly<Record<string, string>>,
): { readonly argv: readonly string[]; readonly fit: OperandFit } {
  const operand = argv[index] ?? "";
  const build = (length: number) => [
    ...prefix,
    ...argv.slice(0, index),
    operand.slice(0, length),
    ...argv.slice(index + 1),
  ];
  const exercised = spawnableLength(build, env, operand.length);
  return {
    argv: build(exercised).slice(prefix.length),
    fit: {
      frozenLength: operand.length,
      refusedLength: exercised === operand.length ? null : operand.length,
      shortestRefusedLength:
        exercised === operand.length ? null : exercised + 1,
      exercisedLength: exercised,
    },
  };
}

export async function launchCase(
  entry: Case,
  overrides: Partial<Parameters<typeof launch>[0]> = {},
) {
  return launch({
    argv: entry.argv,
    state: entry.state,
    scenario: entry.scenario,
    stdin: entry.stdin,
    ...overrides,
  });
}

export function frontDoorStart(observed: Observed): number {
  const line = observed.ledger.find((entry) =>
    entry.startsWith("front-door-start "),
  );
  const value = line ? Number(line.split(" ")[1]) : Number.NaN;
  if (!Number.isFinite(value))
    throw new Error("UNPROVED: the fixture ledgered no front-door start.");
  return value;
}

const requiredTools = [
  "/bin/sh",
  "/bin/cat",
  "/bin/sleep",
  "/bin/ps",
  "/usr/bin/perl",
  "/usr/bin/yes",
  "/usr/bin/head",
  "/usr/bin/wc",
  "/usr/bin/tr",
] as const;
export function requireTools(): void {
  const missing = requiredTools.filter((tool) => !existsSync(tool));
  if (missing.length > 0)
    throw new Error(`UNPROVED on this host: missing ${missing.join(", ")}.`);
}

export const exitBound = 20_000;
// Platform: H2: a CLI that calls abort() is reported gone only after the host has dealt
// with the aborted process. Hosted ubuntu runners took 23,798 ms (run
// 43768259751) and 27,461 ms (run 43771790891) for L06s.abort, and more than
// 20,000 ms in run 43780233662; Darwin takes milliseconds. Only the abort
// scenario waits this long, about twice the slowest observation, and its own
// test timeout (abortTimeout) stays above it so R1 still releases a real hang.
export const abortExitBound = 60_000;
export const abortTimeout = 75_000;
export async function exitWithin(
  launched: Launched,
  milliseconds = exitBound,
): Promise<Observed> {
  const observed = await Promise.race([
    launched.done,
    Bun.sleep(milliseconds).then(() => undefined),
  ]);
  if (!observed) {
    await release(launched);
    throw new Error(`The CLI did not exit within ${milliseconds} ms.`);
  }
  return observed;
}
const ledgeredLeaders = ["child-started", "escaped", "late-child"];
function ledgeredPid(ledger: readonly string[], prefix: string) {
  return ledger.flatMap((line) => {
    if (!line.startsWith(`${prefix} `)) return [];

    const pid = Number(line.split(" ")[1]);

    return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  });
}
export function firstPid(ledger: readonly string[], prefix: string) {
  return ledgeredPid(ledger, prefix)[0];
}
function stillOwned(ledger: readonly string[]) {
  const owned = ledgeredLeaders.flatMap((prefix) =>
    ledgeredPid(ledger, prefix).map((pid) => ({ pid, group: pid })),
  );
  const [group] = ledgeredPid(ledger, "child-pgid");
  if (group !== undefined)
    for (const pid of ledgeredPid(ledger, "grandchild"))
      owned.push({ pid, group });
  return owned.filter((entry) => processGroup(entry.pid) === entry.group);
}
export async function release(launched: Launched): Promise<void> {
  if (launched.running()) launched.signal("SIGKILL");
  const observed = await launched.done;
  for (const { pid, group } of stillOwned(readLedger(launched.ledgerPath)))
    if (pid === group) signalGroupIfPresent(group, "SIGKILL");
    else signalIfPresent(pid, "SIGKILL");
  await cleanup(observed);
}

export async function runCase(
  entry: Case,
  extra: Partial<Parameters<typeof launch>[0]> = {},
  bound = exitBound,
) {
  return exitWithin(await launchCase(entry, extra), bound);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function goneWithin(pid: number, milliseconds: number) {
  const until = Date.now() + milliseconds;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await Bun.sleep(5);
  }
  return true;
}
function psField(field: "pgid" | "rss", pid: number): number | undefined {
  const result = Bun.spawnSync(
    ["/bin/ps", "-o", `${field}=`, "-p", String(pid)],
    { timeout: toolBound, killSignal: "SIGKILL" },
  );
  if (result.exitedDueToTimeout === true)
    throw new Error(
      `/bin/ps did not answer within ${toolBound} ms for pid ${pid}.`,
    );
  const value = Number(result.stdout.toString().trim());
  return result.exitCode === 0 && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
export function processGroup(pid: number): number | undefined {
  return psField("pgid", pid);
}
export function residentKilobytes(pid: number): number | undefined {
  return psField("rss", pid);
}

export async function listing(dir: string): Promise<readonly string[]> {
  return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

// Platform: C5: a consumer that takes 4 KiB per read with a real pause between reads.
// The CLI's stdout feeds a Perl relay (sysread of 4,096 bytes, then 2 ms);
// the CLI's own exit status and the relay's read count go to the ledger.
// Bun's subprocess streams offer no BYOB reader, and node:child_process in
// paused mode drops buffered data at child exit on Bun 1.4.4.
const relay =
  "$|=1; my $n=0; while (my $r = sysread(STDIN, my $b, 4096)) { syswrite(STDOUT, $b); $n++; select(undef, undef, undef, 0.002); } open(my $f, '>>', $ENV{FX_LEDGER}); print $f \"relay-reads $n\\n\";";
function quoted(token: string): string {
  return `'${token.replaceAll("'", "'\\''")}'`;
}
export async function slowSmallChunkRun(entry: Case) {
  const shell = `{ "$0" "$1" ${entry.argv.map(quoted).join(" ")}; echo "cli-exit $?" >> "$FX_LEDGER"; } | /usr/bin/perl -e ${quoted(relay)}`;
  const observed = await exitWithin(
    await launchCase(entry, { rawArgvShell: shell }),
  );
  const field = (prefix: string) => {
    const line = observed.ledger.find((item) => item.startsWith(`${prefix} `));
    const value = line ? Number(line.split(" ")[1]) : Number.NaN;
    if (!Number.isSafeInteger(value))
      throw new Error(`UNPROVED: the relay ledgered no ${prefix}.`);
    return value;
  };
  return {
    observed: { ...observed, code: field("cli-exit") },
    reads: field("relay-reads"),
  };
}

const decoder = new TextDecoder();
export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function envelopeOf(bytes: Uint8Array): Record<string, unknown> {
  const raw = text(bytes);
  if (!raw.endsWith("\n") || raw.indexOf("\n") !== raw.length - 1)
    throw new Error("stdout is not one object followed by one newline");
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed)) throw new Error("stdout is not one JSON object");
  return parsed;
}

export function resultOf(envelope: Record<string, unknown>) {
  const result = envelope.result;
  if (!record(result)) throw new Error("envelope has no result");
  return result;
}

export function deepestLevel(value: unknown): number {
  let deepest = 0;
  const stack: { readonly value: unknown; readonly level: number }[] = [
    { value, level: 0 },
  ];
  for (let item = stack.pop(); item; item = stack.pop()) {
    deepest = Math.max(deepest, item.level);
    if (item.value === null || typeof item.value !== "object") continue;
    for (const child of Object.values(item.value))
      stack.push({ value: child, level: item.level + 1 });
  }
  return deepest;
}
