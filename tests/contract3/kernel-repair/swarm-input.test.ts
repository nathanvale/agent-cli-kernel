import { expect, test } from "bun:test";
import { contractFor } from "../../../starters/contract3/src/kernel/index.ts";
import {
  filterShow,
  go,
  goStation,
  patternShow,
  titledShow,
} from "./swarm-commands.ts";
import { runScenario } from "./swarm-process.ts";

// Swarm-triage expectations for input and command-step admission. Expected
// values come from the triage file's "Expectations for confirmed findings"
// (X-K1-*), written from the frozen contract, never from kernel output.
const processTimeout = 60_000;

test(
  "X-K1-1.pattern-validity: an invalid Unicode pattern is refused at declaration; a valid one matches the whole operand",
  async () => {
    // INPUT-2: a pattern is a valid ECMAScript Unicode regular expression.
    // `a)|(?:b` compiles only inside a `^(?:...)$` wrapper.
    expect(() => patternShow("a)|(?:b")).toThrow(
      "Invalid Unicode pattern in input declaration.",
    );
    // Twin: a valid pattern is admitted and matched against the full string.
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

// The route of each test-owned command, for running an emitted step.
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
    // INPUT-3: a value-taking option consumes its value after global-switch
    // handling, so `--title --help` routes to help; F01 option 2 refuses it.
    for (const value of ["--help", "--discover", "--discover-command"])
      expect(() =>
        contractFor({
          cli: "x",
          commands: [titledShow(), go(["--title", value])],
        }),
      ).toThrow("Command step args carry a global switch before --.");
    // Twin: a plain value is admitted and the emitted step runs as x.show.
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
    // INPUT-3: `--` ends option parsing; later tokens are operands,
    // including `--json`. STEP-6 excludes only the global switch.
    expect(goStation(["--", "--json"]).guidance.next.args).toEqual([
      "--",
      "--json",
    ]);
    expect(() =>
      contractFor({ cli: "x", commands: [filterShow(), go(["--", "--json"])] }),
    ).not.toThrow();
    // The emitted step validates: the success prints, not the fallback.
    const went = await runScenario("json-after-delimiter", ["go", "--json"]);
    expect(went.exit).toBe(0);
    const step = nextOf(went.result);
    expect(step).toEqual({
      command: "x.show",
      args: ["--", "--json"],
      route: ["show"],
    });
    // The caller places its own `--json` before the step's arguments.
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
    // Twin: `--json` before `--` is the global switch and is refused.
    expect(() => goStation(["--json"])).toThrow(
      "Command step args carry a global switch before --.",
    );
  },
  processTimeout,
);
