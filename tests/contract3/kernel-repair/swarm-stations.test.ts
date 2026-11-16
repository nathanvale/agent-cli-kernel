import { expect, test } from "bun:test";
import { schemaLoad } from "./swarm-commands.ts";
import type { Observed } from "./swarm-process.ts";
import { runScenario } from "./swarm-process.ts";

// Swarm-triage expectations for kernel-supplied stations (X-K1-6, X-K1-8).
// Expected values come from the triage file's expectations, written from the
// frozen contract, never from kernel output.
const processTimeout = 60_000;

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
    expect(stationsOf(schemaLoad(), "x.load")).toContainEqual(
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
function discovered(observed: Observed, causeCode: string): unknown {
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
