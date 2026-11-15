// Process harness for the T2 slice A cases. It runs the labelled fault-fixture
// CLI as a real child process and observes raw stdout/stderr bytes, the real
// exit or signal, a fixture ledger written by child programs, the OS process
// table and the harness clock. Expected values come only from t2-cases.json.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";

const here = import.meta.dir;
const repository = resolve(here, "../../..");
const faultCli = join(here, "fixtures/fault-cli.ts");

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

// A frozen numeric expectation; a missing one fails the case.
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
  | "close-after-envelope"
  | "slow-chunks";

export type Observed = {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly code: number | null;
  readonly signal: string | null;
  readonly pid: number;
  readonly spawnedAt: number;
  readonly exitedAt: number;
  readonly firstStdoutAt: number | undefined;
  readonly ledger: readonly string[];
  readonly dir: string;
};

export type Launched = {
  readonly pid: number;
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
  const target = join(dir, "starters/contract3/src/addons/state");
  await mkdir(target, { recursive: true });
  const entry = join(target, "fx-state-entry.ts");
  const template = readFileSync(
    join(here, "fixtures/state-entry.ts.txt"),
    "utf8",
  )
    .replace(
      "__KERNEL_INDEX__",
      join(repository, "starters/contract3/src/kernel/index.ts"),
    )
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

const heldBytes = new TextEncoder().encode("FX-HELD-STDIN-BYTES\n".repeat(64));

export async function launch(options: {
  readonly argv: readonly string[];
  readonly state?: boolean;
  readonly scenario?: string | undefined;
  readonly stdin?: "closed" | "held-open";
  readonly reader?: Reader;
  readonly env?: Readonly<Record<string, string>>;
  readonly rawArgvShell?: string;
}): Promise<Launched> {
  const dir = await mkdtemp(join(tmpdir(), "contract3-t2-"));
  const ledgerPath = join(dir, "ledger");
  const work = join(dir, "work");
  const temp = join(dir, "tmp");
  await mkdir(work);
  await mkdir(temp);
  const entry = options.state ? await materialiseStateEntry(dir) : faultCli;
  const command = options.rawArgvShell
    ? ["/bin/sh", "-c", options.rawArgvShell, process.execPath, entry]
    : [process.execPath, entry, ...options.argv];
  const spawnedAt = performance.now();
  const child = Bun.spawn(command, {
    cwd: work,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? dir,
      TMPDIR: temp,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      FX_LEDGER: ledgerPath,
      FX_SCENARIO: options.scenario ?? "",
      ...options.env,
    },
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
      firstStdoutAt ??= performance.now();
      chunks.push(next.value);
      if (reader === "pause-after-first") {
        markPartial(performance.now());
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
      if (reader === "slow-chunks") await Bun.sleep(1);
    }
  })();
  const stderrDone = new Response(child.stderr).arrayBuffer();
  const done = (async (): Promise<Observed> => {
    await child.exited;
    const exitedAt = performance.now();
    const [, stderr] = await Promise.all([
      Promise.race([stdoutDone, Bun.sleep(2000)]),
      stderrDone,
    ]);
    if (options.stdin === "held-open") void child.stdin.end();
    return {
      stdout: concat(chunks),
      stderr: new Uint8Array(stderr),
      code: child.signalCode ? null : child.exitCode,
      signal: child.signalCode,
      pid: child.pid,
      spawnedAt,
      exitedAt,
      firstStdoutAt,
      ledger: readLedger(ledgerPath),
      dir,
    };
  })();
  return {
    pid: child.pid,
    dir,
    ledgerPath,
    spawnedAt,
    signal(name) {
      child.kill(name);
      return performance.now();
    },
    async barrier(prefix, milliseconds = 10_000) {
      const until = performance.now() + milliseconds;
      while (performance.now() < until) {
        if (readLedger(ledgerPath).some((line) => line.startsWith(prefix)))
          return performance.now();
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

export async function run(
  entry: Case,
  extra: Partial<Parameters<typeof launch>[0]> = {},
) {
  const launched = await launch({
    argv: entry.argv,
    state: entry.state,
    scenario: entry.scenario,
    stdin: entry.stdin,
    ...extra,
  });
  return launched.done;
}

// Independent process-table probe.
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function goneWithin(pid: number, milliseconds: number) {
  const until = performance.now() + milliseconds;
  while (alive(pid)) {
    if (performance.now() > until) return false;
    await Bun.sleep(5);
  }
  return true;
}
export function processGroup(pid: number): number | undefined {
  const result = Bun.spawnSync(["/bin/ps", "-o", "pgid=", "-p", String(pid)]);
  const text = result.stdout.toString().trim();
  return text ? Number(text) : undefined;
}

export async function listing(dir: string): Promise<readonly string[]> {
  return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

const decoder = new TextDecoder();
export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

// Strict parse: exactly one JSON object followed by exactly one newline.
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

export function containerDepth(value: unknown): number {
  let deepest = 0;
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 1 },
  ];
  for (let item = stack.pop(); item; item = stack.pop()) {
    if (item.value === null || typeof item.value !== "object") continue;
    deepest = Math.max(deepest, item.depth);
    for (const child of Object.values(item.value))
      stack.push({ value: child, depth: item.depth + 1 });
  }
  return deepest;
}
