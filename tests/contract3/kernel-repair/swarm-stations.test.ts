import { expect, test } from "bun:test";
import { schemaLoad } from "./swarm-commands.ts";
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
