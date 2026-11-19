import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeOf } from "../../../kernel/src/kernel/runtime.ts";
import type { ContractKey } from "../../../kernel/src/kernel/runtime.ts";
import { selectingLoad } from "./swarm-commands.ts";
import type { ScenarioRun } from "./swarm-process.ts";
import { processWatchdog, runScenario } from "./swarm-process.ts";

const processTimeout = processWatchdog(3);

function stationsOf(contract: ContractKey, identity: string): unknown[] {
  const runtime = runtimeOf(contract);
  if (!runtime) throw new Error("No discoverCommand.");
  const data: unknown = runtime.navigation.discoverCommand(identity);
  const stations: unknown =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "stations")
      : undefined;
  return Array.isArray(stations) ? stations : [];
}

test(
  "X-K1-6.schema-station-reachable: a base-added required SCHEMA_INVALID_INPUT is produced by a process invocation",
  async () => {
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
    const unknown = await runScenario("default-words", ["nosuch", "--json"]);
    expect(unknown.exit).toBe(2);
    expect(unknown.result).toMatchObject({
      commandIdentity: "x.dispatch",
      causeCode: "USAGE_UNKNOWN_COMMAND",
      next: { kind: "instruction" },
    });
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
    expect(discovered(read, "USAGE_INVALID_INVOCATION")).toMatchObject({
      guidance: {
        next: {
          kind: "command",
          command: "x.command-discovery",
          args: ["x.read"],
        },
      },
    });
  },
  processTimeout,
);

async function approvalRun(env: Readonly<Record<string, string>>) {
  const directory = await mkdtemp(join(tmpdir(), "kernel-swarm-approval-"));
  try {
    const ledger = join(directory, "ledger.txt");
    const store = join(directory, "store");
    await mkdir(store);
    const scenarioEnv = { ...env, LEDGER: ledger };
    const observed = await runScenario(
      "inspect-approval",
      ["read", "--json"],
      env.GRANTS === "" ? { ...scenarioEnv, GRANTS: store } : scenarioEnv,
    );
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
    const refused = await approvalRun({ CHECK: "false" });
    expect(refused.observed.exit).toBe(3);
    expect(refused.observed.result).toMatchObject(denied);
    expect(refused.lines).toEqual(["check"]);
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

async function selection(causeCode: string, ownStation: boolean) {
  const contract = selectingLoad(causeCode, ownStation);
  const runtime = runtimeOf(contract);
  const buildResult: unknown = Reflect.get(contract, "buildResult");
  if (!runtime || typeof buildResult !== "function")
    throw new Error("No execute.");
  try {
    const executed = await runtime.execute(
      "x.load",
      ["abc"],
      `run-${causeCode}`,
      {},
    );
    const value: unknown = executed.ok ? executed.value : undefined;
    const built: unknown = await Reflect.apply(buildResult, contract, [value]);
    return built;
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

test("K1-6.declared-table-selects-base-added: a command with its own stations may select SCHEMA_INVALID_INPUT", async () => {
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
