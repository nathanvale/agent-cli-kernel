import { expect, test } from "bun:test";
import { patternShow } from "./swarm-commands.ts";
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
