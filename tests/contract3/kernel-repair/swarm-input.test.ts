import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import {
  filterShow,
  go,
  goStation,
  patternShow,
  titledShow,
} from "./swarm-commands.ts";
import { buildUnchecked, contractUnchecked } from "./harness.ts";
import { emptyInput, unchanged } from "./shapes.ts";
import { processWatchdog, runScenario } from "./swarm-process.ts";

const processTimeout = processWatchdog(2);

test(
  "X-K1-1.pattern-validity: an invalid Unicode pattern is refused at declaration; a valid one matches the whole operand",
  async () => {
    expect(() => patternShow("a)|(?:b")).toThrow(
      "Invalid Unicode pattern in input declaration.",
    );
    const valid = await runScenario("pattern", ["show", "a", "--json"], {
      PATTERN: "a|b",
    });
    expect(valid.exit).toBe(0);
    expect(valid.result).toMatchObject({
      commandIdentity: "x.show",
      causeCode: "SUCCESS_UNCHANGED",
    });
    const partial = await runScenario("pattern", ["show", "axyz!!", "--json"], {
      PATTERN: "a|b",
    });
    expect(partial.exit).toBe(2);
    expect(partial.result).toMatchObject({
      commandIdentity: "x.show",
      causeCode: "USAGE_INVALID_INVOCATION",
    });
  },
  processTimeout,
);

const routes: Readonly<Record<string, readonly string[]>> = {
  "x.show": ["show"],
  "x.go": ["go"],
};
function nextOf(result: Readonly<Record<string, unknown>> | undefined) {
  const next: unknown = result?.next;
  const command: unknown =
    typeof next === "object" && next !== null
      ? Reflect.get(next, "command")
      : undefined;
  const args: unknown =
    typeof next === "object" && next !== null
      ? Reflect.get(next, "args")
      : undefined;
  const route = typeof command === "string" ? routes[command] : undefined;
  if (!route || !Array.isArray(args)) throw new Error("No command step.");
  return { command, args: args.map(String), route };
}

test(
  "X-K1-2.navigation-switch-value: a navigation switch as a step's option value is refused at declaration",
  async () => {
    for (const value of ["--help", "--discover", "--discover-command"])
      expect(() =>
        contractFor({
          cli: "x",
          commands: [titledShow(), go(["--title", value])],
        }),
      ).toThrow("Command step args carry a global switch before --.");
    const went = await runScenario("navigation-value", ["go", "--json"], {
      VALUE: "plain",
    });
    expect(went.exit).toBe(0);
    const step = nextOf(went.result);
    expect(step).toEqual({
      command: "x.show",
      args: ["--title", "plain"],
      route: ["show"],
    });
    const shown = await runScenario(
      "navigation-value",
      [...step.route, ...step.args, "--json"],
      { VALUE: "plain" },
    );
    expect(shown.exit).toBe(0);
    expect(shown.result).toMatchObject({
      commandIdentity: "x.show",
      causeCode: "SUCCESS_UNCHANGED",
      data: { title: "plain" },
    });
  },
  processTimeout,
);

test(
  "X-K1-13.json-after-delimiter: `--json` after `--` is an operand in a step; before `--` it is refused",
  async () => {
    expect(goStation(["--", "--json"]).guidance.next.args).toEqual([
      "--",
      "--json",
    ]);
    expect(() =>
      contractFor({ cli: "x", commands: [filterShow(), go(["--", "--json"])] }),
    ).not.toThrow();
    const went = await runScenario("json-after-delimiter", ["go", "--json"]);
    expect(went.exit).toBe(0);
    const step = nextOf(went.result);
    expect(step).toEqual({
      command: "x.show",
      args: ["--", "--json"],
      route: ["show"],
    });
    const shown = await runScenario("json-after-delimiter", [
      ...step.route,
      "--json",
      ...step.args,
    ]);
    expect(shown.exit).toBe(0);
    expect(shown.result).toMatchObject({
      commandIdentity: "x.show",
      causeCode: "SUCCESS_UNCHANGED",
      data: { filter: "--json" },
    });
    expect(() => goStation(["--json"])).toThrow(
      "Command step args carry a global switch before --.",
    );
  },
  processTimeout,
);

test("X-K1-12.dispatch-step: `<cli>.dispatch` with no arguments is an admitted command step", async () => {
  const went = station(commonCauses, {
    commandIdentity: "x.go",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Went.",
    guidance: { next: { kind: "command", command: "x.dispatch", args: [] } },
    repairAction: null,
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "swarm-input",
  });
  const source = command({
    identity: "x.go",
    route: ["go"],
    summary: "Go.",
    input: emptyInput,
    capabilities: {},
    stations: [went],
    run: (_input, context) =>
      context.result(went, {
        message: "Went.",
        data: null,
        effects: unchanged,
      }),
  });
  const contract = contractUnchecked(contractFor, {
    cli: "x",
    commands: [source],
  });
  if (typeof contract !== "object" || contract === null)
    throw new Error("Expected an admitted contract.");
  const built = await buildUnchecked(contract, went, {
    runId: "run-dispatch-step",
    message: "Went.",
    data: null,
    effects: unchanged,
  });
  expect(built).toMatchObject({
    ok: true,
    value: {
      result: { next: { kind: "command", command: "x.dispatch", args: [] } },
    },
  });
  const resolve: unknown = Reflect.get(contract, "resolve");
  if (typeof resolve !== "function") throw new Error("No resolve.");
  const resolved: unknown = await Reflect.apply(resolve, contract, [[]]);
  expect(resolved).toMatchObject({ commandIdentity: "x.dispatch" });
});
