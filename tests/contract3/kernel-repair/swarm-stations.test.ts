import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectingLoad } from "./swarm-commands.ts";
import type { ScenarioRun } from "./swarm-process.ts";
import { processWatchdog, runScenario } from "./swarm-process.ts";

// Swarm-triage expectations for kernel-supplied stations (X-K1-6, X-K1-8).
// Expected values come from the triage file's expectations, written from the
// frozen contract, never from kernel output.
// Each test here runs at most three child processes.
const processTimeout = processWatchdog(3);

function stationsOf(contract: object, identity: string): unknown[] {
  const discover: unknown = Reflect.get(contract, "discoverCommand");
  if (typeof discover !== "function") throw new Error("No discoverCommand.");
  const data: unknown = Reflect.apply(discover, contract, [identity]);
  const stations: unknown =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "stations")
      : undefined;
  return Array.isArray(stations) ? stations : [];
}

test(
  "X-K1-6.schema-station-reachable: a base-added required SCHEMA_INVALID_INPUT is produced by a process invocation",
  async () => {
    // DISC-11b: a handler may select a station the base adds, for example
    // SCHEMA_INVALID_INPUT for a bad persisted-state shape. DISC-12: every
    // required station is reached by a process test.
    expect(
      stationsOf(selectingLoad("SCHEMA_INVALID_INPUT", false), "x.load"),
    ).toContainEqual(
      expect.objectContaining({
        causeCode: "SCHEMA_INVALID_INPUT",
        reachability: "required",
      }),
    );
    const loaded = await runScenario("schema-station", [
      "load",
      "abc",
      "--json",
    ]);
    expect({ exit: loaded.exit, stderr: loaded.stderr }).toEqual({
      exit: 4,
      stderr: "",
    });
    expect(loaded.result).toMatchObject({
      commandIdentity: "x.load",
      outcome: "refused",
      transactionState: "unchanged",
      causeCode: "SCHEMA_INVALID_INPUT",
      failureClass: "schema",
      exitCode: 4,
    });
  },
  processTimeout,
);

// A PublicStation carries its step under `guidance` (DISC-8).
function nextKind(station: unknown): unknown {
  const guidance: unknown =
    typeof station === "object" && station !== null
      ? Reflect.get(station, "guidance")
      : undefined;
  const next: unknown =
    typeof guidance === "object" && guidance !== null
      ? Reflect.get(guidance, "next")
      : undefined;
  return typeof next === "object" && next !== null
    ? Reflect.get(next, "kind")
    : undefined;
}
function discovered(observed: ScenarioRun, causeCode: string): unknown {
  const data: unknown = observed.result?.data;
  const stations: unknown =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "stations")
      : undefined;
  return Array.isArray(stations)
    ? stations.find(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          Reflect.get(entry, "causeCode") === causeCode,
      )
    : undefined;
}

test(
  "X-K1-8.default-words: base default words follow the WIRE-18 guidance column",
  async () => {
    // STEP-8 "A choice among commands": an instruction, candidates in
    // availablePaths (WIRE-18: select an identity from availablePaths).
    const unknown = await runScenario("default-words", ["nosuch", "--json"]);
    expect(unknown.exit).toBe(2);
    expect(unknown.result).toMatchObject({
      commandIdentity: "x.dispatch",
      causeCode: "USAGE_UNKNOWN_COMMAND",
      next: { kind: "instruction" },
    });
    // WIRE-18: INTERNAL_PREPARATION repairs the CLI or runtime; help neither
    // performs nor checks that repair. Deadline rows are two steps in order
    // (STEP-8): inspect the deadline and input, then decide a new run.
    const read = await runScenario("default-words", [
      "--discover-command",
      "x.read",
      "--json",
    ]);
    const dispatch = await runScenario("default-words", [
      "--discover-command",
      "x.dispatch",
      "--json",
    ]);
    expect([
      nextKind(discovered(read, "INTERNAL_PREPARATION")),
      nextKind(discovered(dispatch, "INTERNAL_PREPARATION")),
      nextKind(discovered(dispatch, "USAGE_UNKNOWN_COMMAND")),
      nextKind(discovered(read, "DOMAIN_DEADLINE_BEFORE_START")),
      nextKind(discovered(read, "DOMAIN_DEADLINE_UNCHANGED")),
    ]).toEqual([
      "instruction",
      "instruction",
      "instruction",
      "instruction",
      "instruction",
    ]);
    // Twin: WIRE-18 USAGE_INVALID_INVOCATION ("inspect help and correct the
    // invocation") keeps its command step to help.
    expect(discovered(read, "USAGE_INVALID_INVOCATION")).toMatchObject({
      guidance: { next: { kind: "command", command: "x.help", args: [] } },
    });
  },
  processTimeout,
);

// Runs the inspect-approval scenario with a fresh ledger and returns what an
// agent sees plus the independent ledger lines.
async function approvalRun(env: Readonly<Record<string, string>>) {
  const directory = await mkdtemp(join(tmpdir(), "contract3-swarm-approval-"));
  try {
    const ledger = join(directory, "ledger.txt");
    const observed = await runScenario("inspect-approval", ["read", "--json"], {
      ...env,
      LEDGER: ledger,
      ...(env.GRANTS === "" ? { GRANTS: join(directory, "store") } : {}),
    });
    const lines = (await readFile(ledger, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "");
    return { observed, lines };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const denied = {
  commandIdentity: "x.read",
  outcome: "refused",
  transactionState: "unchanged",
  causeCode: "DOMAIN_AUTHORITY_REQUIRED",
  exitCode: 3,
  handoff: { owner: "human" },
};

test(
  "X-K1-3.inspect-approval-guard: an inspect command that declares approval is guarded before its handler",
  async () => {
    // CMD-3, CMD-4, CMD-15: the approval guard runs on an inspect command
    // too, after input validation and before the handler (CMD-9 step 5).
    const refused = await approvalRun({ CHECK: "false" });
    expect(refused.observed.exit).toBe(3);
    expect(refused.observed.result).toMatchObject(denied);
    expect(refused.lines).toEqual(["check"]);
    // Twin: an accepting check enters the handler once.
    const admitted = await approvalRun({ CHECK: "true" });
    expect(admitted.observed.exit).toBe(0);
    expect(admitted.observed.result).toMatchObject({
      commandIdentity: "x.read",
      causeCode: "SUCCESS_UNCHANGED",
    });
    expect(admitted.lines).toEqual(["check", "handler-entered"]);
  },
  processTimeout,
);

test(
  "X-S7.inspect-approval-guard: the shipped approval add-on with no grant denies an inspect command",
  async () => {
    // CMD-15 first bullet; CMD-4; DISC-12 for the required station; B3:
    // the base's default words name the owner role `human`.
    const shipped = await approvalRun({ GRANTS: "" });
    expect({
      exit: shipped.observed.exit,
      stderr: shipped.observed.stderr,
    }).toEqual({
      exit: 3,
      stderr: "",
    });
    expect(shipped.observed.result).toMatchObject(denied);
    expect(shipped.observed.stdout.trim().split("\n")).toHaveLength(1);
    expect(shipped.lines).toEqual([]);
  },
  processTimeout,
);

// Runs x.load in process and reports what the handler's selection produced.
async function selection(causeCode: string, ownStation: boolean) {
  const contract = selectingLoad(causeCode, ownStation);
  const execute: unknown = Reflect.get(contract, "execute");
  const buildResult: unknown = Reflect.get(contract, "buildResult");
  if (typeof execute !== "function" || typeof buildResult !== "function")
    throw new Error("No execute.");
  try {
    const executed: unknown = await Reflect.apply(execute, contract, [
      "x.load",
      ["abc"],
      `run-${causeCode}`,
    ]);
    const value: unknown =
      typeof executed === "object" && executed !== null
        ? Reflect.get(executed, "value")
        : undefined;
    const built: unknown = await Reflect.apply(buildResult, contract, [value]);
    return built;
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

test("K1-6.declared-table-selects-base-added: a command with its own stations may select SCHEMA_INVALID_INPUT", async () => {
  // DISC-11b: a handler may select a station the base adds; declaring a
  // station table does not remove that (repair 1, K1-6 boundary a).
  expect(await selection("SCHEMA_INVALID_INPUT", true)).toMatchObject({
    ok: true,
    value: {
      result: {
        commandIdentity: "x.load",
        causeCode: "SCHEMA_INVALID_INPUT",
        outcome: "refused",
        exitCode: 4,
      },
    },
  });
});

test("K1-6.reserved-stays-unselectable: a handler never selects a fallback-reserved station", async () => {
  // DISC-11b: INTERNAL_PREPARATION and every INTERNAL_RESULT_* keep the
  // base's fixed words and are the fallback's alone (repair 1, boundary b).
  const refused = {
    thrown: "Result station belongs to another command or is undeclared.",
  };
  for (const ownStation of [false, true])
    for (const causeCode of [
      "INTERNAL_PREPARATION",
      "INTERNAL_RESULT_UNCHANGED",
    ])
      expect(await selection(causeCode, ownStation)).toEqual(refused);
});
