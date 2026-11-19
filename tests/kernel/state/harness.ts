import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { testFolder } from "../../support/test-folder.ts";
import { stateCases } from "./cases.ts";
import { coordinationExpected } from "./holder.ts";

const specimen = join(import.meta.dir, "fixtures", "specimen.ts");

export function caseTest(
  id: string,
  body: () => Promise<void>,
  timeout = 90_000,
): void {
  const row = stateCases.find((entry) => entry.id === id);
  if (!row || row.status !== "executable")
    throw new Error(`${id} is not an executable frozen case.`);
  if (row.platform === "coordination" && !coordinationExpected) {
    test(
      `${id} UNPROVED on ${process.platform}: fail-closed control only`,
      failClosedControl,
      timeout,
    );
    return;
  }
  if (row.nonRoot === true && process.geteuid?.() === 0) {
    test(`${id} UNPROVED as euid 0: root is never denied permission`, () => {
      expect(process.geteuid?.()).toBe(0);
    });
    return;
  }
  test(id, body, timeout);
}

async function failClosedControl(): Promise<void> {
  const world = makeWorld();
  try {
    const run = await world.run(["apply", "a", "--content", "x", "--json"]);
    expect(run.exit).toBe(3);
    expect(run.result.causeCode).toBe("DOMAIN_SX_UNAVAILABLE");
    expect(run.envelope.message).toContain(
      process.platform === "linux"
        ? "coordination-self-check-failed"
        : "coordination-unqualified-platform",
    );
    expect(world.ledger()).toEqual([]);
    expect(existsSync(world.root)).toBe(false);
  } finally {
    world.dispose();
  }
}

export function supportingTest(
  title: string,
  body: () => Promise<void>,
  timeout = 90_000,
): void {
  if (!coordinationExpected) {
    test(
      `${title} UNPROVED on ${process.platform}: fail-closed control only`,
      failClosedControl,
      timeout,
    );
    return;
  }
  test(title, body, timeout);
}

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export function json(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry: unknown) => json(entry));
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) out[key] = json(entry);
    return out;
  }
  throw new Error("Not JSON.");
}
export function at(
  value: Json | undefined,
  ...path: (string | number)[]
): Json | undefined {
  let current: Json | undefined = value;
  for (const key of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    )
      return undefined;
    current = Array.isArray(current)
      ? typeof key === "number"
        ? current[key]
        : undefined
      : typeof key === "string"
        ? current[key]
        : undefined;
  }
  return current;
}
export function str(value: Json | undefined): string {
  if (typeof value !== "string")
    throw new Error(`Expected string, got ${JSON.stringify(value)}.`);
  return value;
}

export type Run = {
  readonly exit: number | null;
  readonly signal: NodeJS.Signals | number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: { readonly message: Json | undefined; readonly raw: Json };
  readonly result: {
    readonly causeCode: Json | undefined;
    readonly outcome: Json | undefined;
    readonly transactionState: Json | undefined;
    readonly exitCode: Json | undefined;
    readonly retryable: Json | undefined;
    readonly raw: Json | undefined;
  };
};

function parseRun(
  exit: number | null,
  signal: NodeJS.Signals | number | null,
  stdout: string,
  stderr: string,
): Run {
  let raw: Json;
  try {
    raw = json(JSON.parse(stdout));
  } catch {
    raw = null;
  }
  const result = at(raw, "result");
  return {
    exit,
    signal,
    stdout,
    stderr,
    envelope: { message: at(raw, "message"), raw },
    result: {
      causeCode: at(result, "causeCode"),
      outcome: at(result, "outcome"),
      transactionState: at(result, "transactionState"),
      exitCode: at(result, "exitCode"),
      retryable: at(result, "retryable"),
      raw: result,
    },
  };
}

export type Record_ = {
  readonly kind: string;
  readonly payload: { [key: string]: Json };
};
export type FileRead = {
  readonly records: readonly Record_[];
  readonly torn: boolean;
  readonly corrupt: boolean;
};

const recordStart = /(^|\n)C3S1 [a-z-]{1,24} \d{10} [0-9a-f]{64}\n/;
const headerLine = /^C3S1 ([a-z-]{1,24}) (\d{10}) ([0-9a-f]{64})$/;
const decoder = new TextDecoder();

function readRecordAt(
  bytes: Uint8Array,
  offset: number,
): { readonly record: Record_; readonly end: number } | undefined {
  const newline = bytes.indexOf(10, offset);
  if (newline < 0) return undefined;
  const match = headerLine.exec(
    decoder.decode(bytes.subarray(offset, newline)),
  );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const start = newline + 1;
  const end = start + Number(match[2]);
  if (end + 1 > bytes.length || bytes[end] !== 10) return undefined;
  const body = bytes.subarray(start, end);
  const digest = createHash("sha256")
    .update(`${match[1]}\n`)
    .update(body)
    .digest("hex");
  if (digest !== match[3]) return undefined;
  const payload = parsePayload(body);
  return payload && payload.kind === match[1] && payload.format === 1
    ? { record: { kind: match[1], payload }, end: end + 1 }
    : undefined;
}

function parsePayload(body: Uint8Array): { [key: string]: Json } | undefined {
  try {
    const payload = json(JSON.parse(decoder.decode(body)));
    return payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload)
      ? payload
      : undefined;
  } catch {
    return undefined;
  }
}

export function readFramed(bytes: Uint8Array): FileRead {
  const records: Record_[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const next = readRecordAt(bytes, offset);
    if (!next) {
      const newline = bytes.indexOf(10, offset);
      const rest = bytes.subarray(newline < 0 ? bytes.length : newline + 1);
      const more = recordStart.test(decoder.decode(rest));
      return { records, torn: !more, corrupt: more };
    }
    records.push(next.record);
    offset = next.end;
  }
  return { records, torn: false, corrupt: false };
}

export function framed(
  kind: string,
  payload: Readonly<Record<string, Json>>,
): string {
  const body = JSON.stringify({ ...payload, format: 1, kind });
  const digest = createHash("sha256")
    .update(`${kind}\n`)
    .update(body)
    .digest("hex");
  return `C3S1 ${kind} ${String(new TextEncoder().encode(body).length).padStart(10, "0")} ${digest}\n${body}\n`;
}

export const journals = {
  one: "contract3.state",
  two: "contract3.state.2",
} as const;

export function formatRecord(journal: string): string {
  return framed("format", { journal });
}

export function versionTwoStore(root: string): void {
  for (const folder of ["coordination", "operations", "settled", "staging"])
    mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "format"), formatRecord(journals.two));
}

export function writeSyntheticOperation(
  root: string,
  path: string,
  options: { readonly id?: string; readonly completed?: true } = {},
): string {
  const id =
    options.id ??
    `op-${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
  const directory = join(root, "operations", id);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "intent"),
    framed("intent", {
      operationId: id,
      commandIdentity: "test.synthetic",
      runId: "synthetic-run",
      effects: ["note.write"],
      scope: {
        resources: [{ resource: "note:synthetic", path, keys: [] }],
        invariants: [],
        unknown: false,
        keys: [],
      },
      revisions: {},
      facts: null,
      approval: null,
      closes: null,
      owner: { lease: "owner.lease", pid: 0, startedAt: 0 },
      coordination: [],
    }),
  );
  writeFileSync(
    join(directory, "events"),
    options.completed
      ? `${framed("effect-started", { effect: "note.write" })}${framed("effect-confirmed", { effect: "note.write" })}${framed("completion", { completed: ["note.write"] })}`
      : "",
  );
  writeFileSync(join(directory, "owner.lease"), "");
  return id;
}

export function closeArgs(
  id: string,
  revision: string,
  disposition = "completed",
  closureId = "c1",
  ...extra: string[]
): string[] {
  return [
    "close",
    id,
    "--disposition",
    disposition,
    "--closure-id",
    closureId,
    "--revision",
    revision,
    "--reason",
    "independent evidence reviewed",
    ...extra,
    "--json",
  ];
}

export type Observed = {
  readonly id: string;
  readonly intent: { [key: string]: Json };
  readonly events: FileRead;
  readonly closure: FileRead | undefined;
};

export function readOperations(
  root: string,
  folder: "operations" | "settled" = "operations",
): readonly Observed[] {
  const directory = join(root, folder);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .map((id) => {
      const intent = readFramed(readFileSync(join(directory, id, "intent")));
      const first = intent.records[0];
      if (!first || intent.records.length !== 1)
        throw new Error(`Unreadable intent ${id}.`);
      const closurePath = join(directory, id, "closure");
      return {
        id,
        intent: first.payload,
        events: readFramed(readFileSync(join(directory, id, "events"))),
        closure: existsSync(closurePath)
          ? readFramed(readFileSync(closurePath))
          : undefined,
      };
    });
}

export function versionOneReader(root: string): Json {
  const format = readFramed(readFileSync(join(root, "format")));
  const [record, ...rest] = format.records;
  const accepted =
    !format.torn &&
    !format.corrupt &&
    rest.length === 0 &&
    record?.kind === "format" &&
    record.payload.journal === journals.one;
  if (!accepted) return "corrupt";
  const operations = readOperations(root);
  if (operations.some((operation) => operation.events.corrupt))
    return "corrupt";
  return operations.map(versionOneStatus).sort();
}

function versionOneStatus(operation: Observed): string {
  const closure = operation.closure;
  if (
    closure &&
    !closure.torn &&
    !closure.corrupt &&
    closure.records.length === 1 &&
    closure.records[0]?.kind === "closure"
  )
    return "closed";
  const own = operation.events.records.find(
    (record) => record.kind === "completion" || record.kind === "not-applied",
  );
  return own?.kind === "completion" ? "completed" : (own?.kind ?? "unresolved");
}

export type Started = {
  readonly pid: number;
  readonly reached: (phase: string) => Promise<void>;
  readonly release: (phase: string) => void;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly done: Promise<Run>;
};

export type World = ReturnType<typeof makeWorld>;

export function makeWorld(
  options: { readonly qualification?: "fixture"; readonly entry?: string } = {},
) {
  const program = options.entry ?? specimen;
  const base = testFolder("c3-state-");
  const root = join(base, "state");
  const world = join(base, "world");
  const bars = join(base, "barriers");
  mkdirSync(world, { recursive: true });
  mkdirSync(join(world, "notes"), { recursive: true });
  mkdirSync(bars);
  const children: { kill: (signal?: number | NodeJS.Signals) => void }[] = [];

  function env(
    extra: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !key.startsWith("SX_")) out[key] = value;
    const environment = {
      ...out,
      SX_ROOT: root,
      SX_WORLD: world,
      SX_BARRIER_DIR: bars,
    };
    return {
      ...(options.qualification
        ? { ...environment, SX_QUALIFICATION: options.qualification }
        : environment),
      ...extra,
    };
  }

  function start(
    argv: readonly string[],
    extra: Readonly<Record<string, string>> = {},
    limitMilliseconds?: number,
  ): Started {
    const barrierDirectory = extra.SX_BARRIER_DIR ?? bars;
    const child = Bun.spawn([process.execPath, program, ...argv], {
      env: env(extra),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    let outlived = false;
    const limit =
      limitMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            outlived = true;
            child.kill("SIGKILL");
          }, limitMilliseconds);
    const done = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      clearTimeout(limit);
      if (outlived)
        throw new Error(
          `${argv.join(" ")} outlived its ${String(limitMilliseconds)} ms limit and was killed.`,
        );
      return parseRun(
        child.signalCode ? null : child.exitCode,
        child.signalCode ?? null,
        stdout,
        stderr,
      );
    })();
    return {
      pid: child.pid,
      done,
      async reached(phase: string) {
        const file = join(barrierDirectory, `${phase}.reached`);
        const until = Date.now() + 60_000;
        let exited = false;
        void child.exited.then(() => {
          exited = true;
        });
        while (!existsSync(file)) {
          if (exited)
            throw new Error(`Process exited before reaching ${phase}.`);
          if (Date.now() > until)
            throw new Error(`Barrier ${phase} never reached.`);
          await Bun.sleep(5);
        }
        rmSync(file);
      },
      release(phase: string) {
        writeFileSync(join(barrierDirectory, `${phase}.release`), "go\n");
      },
      kill(signal: NodeJS.Signals = "SIGKILL") {
        child.kill(signal);
      },
    };
  }

  function clearRelease(phase: string): void {
    rmSync(join(bars, `${phase}.release`), { force: true });
  }

  async function run(
    argv: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Promise<Run> {
    return start(argv, extra).done;
  }

  function ledger(): readonly string[] {
    const file = join(world, "ledger.log");
    return existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean)
      : [];
  }
  function labels(): readonly string[] {
    const file = join(world, "labels.log");
    return existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean)
      : [];
  }
  function count(prefix: string): number {
    return ledger().filter((line) => line.startsWith(prefix)).length;
  }
  function note(name: string): string {
    return join(world, "notes", name);
  }
  function noteLedger(name: string): number {
    const real = existsSync(note(name))
      ? realpathSync.native(note(name))
      : note(name);
    return ledger().filter((line) => line.startsWith(`note.write ${real} `))
      .length;
  }

  function snapshot(): string {
    const entries: string[] = [];
    const walk = (directory: string, prefix: string) => {
      if (!existsSync(directory)) return;
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        const stats = statSync(path);
        if (stats.isDirectory()) walk(path, `${prefix}${name}/`);
        else
          entries.push(
            `${prefix}${name} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
          );
      }
    };
    walk(root, "state/");
    walk(world, "world/");
    return entries.join("\n");
  }

  async function pending(): Promise<readonly Json[]> {
    const report = await run(["pending", "--json"]);
    expect(report.exit).toBe(0);
    const list = at(report.result.raw, "data", "unfinished");
    if (!Array.isArray(list)) throw new Error("No unfinished list.");
    return list;
  }
  async function pendingIds(): Promise<readonly string[]> {
    return (await pending()).map((entry) => str(at(entry, "operationId")));
  }
  async function history(id: string): Promise<Run> {
    return run(["history", id, "--json"]);
  }
  async function revision(id: string): Promise<string> {
    return str(
      at((await history(id)).result.raw, "data", "journal", "revision"),
    );
  }

  async function killAt(
    argv: readonly string[],
    phase: string,
    extra: Readonly<Record<string, string>> = {},
  ) {
    const child = start(argv, { SX_BARRIER: phase, ...extra });
    await child.reached(phase);
    child.kill("SIGKILL");
    const result = await child.done;
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toBe("");
    return result;
  }

  return {
    base,
    root,
    world,
    bars,
    start,
    run,
    ledger,
    labels,
    count,
    note,
    noteLedger,
    snapshot,
    pending,
    pendingIds,
    history,
    revision,
    killAt,
    clearRelease,
    operations: () => readOperations(root),
    settled: () => readOperations(root, "settled"),
    cases: () => [...readOperations(root), ...readOperations(root, "settled")],
    dispose() {
      for (const child of children) child.kill("SIGKILL");
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function expectRefusedUnchanged(
  run: Run,
  cause: string,
  exit = 3,
): void {
  expect(run.exit).toBe(exit);
  expect(run.stderr).toBe("");
  expect(run.result.causeCode).toBe(cause);
  expect(run.result.outcome).toBe("refused");
  expect(run.result.transactionState).toBe("unchanged");
  expect(at(run.result.raw, "effects")).toEqual({
    completed: [],
    remaining: [],
    uncertain: [],
    inventoryComplete: true,
  });
  expect(at(run.result.raw, "data")).toBeNull();
}
export function expectCompleted(run: Run): void {
  expect(run.exit).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.result.causeCode).toBe("SUCCESS_COMPLETED");
  expect(run.result.outcome).toBe("success");
  expect(run.result.transactionState).toBe("completed");
  expect(run.result.retryable).toBe(false);
}
