import { describe, expect, test } from "bun:test";
import {
  report,
  stepLimitMilliseconds,
  type Verdict,
} from "../../../scripts/planted-faults.ts";
import {
  captured,
  sample,
  stepVariable,
} from "../../support/planted-fault-in-process-fixture.ts";

describe("stepLimitMilliseconds", () => {
  test.each([
    ["unset", {}],
    ["empty", { [stepVariable]: "" }],
  ])("gives 300 s when the variable is %s", (_name, env) => {
    expect(stepLimitMilliseconds(env)).toBe(300_000);
  });

  test.each([
    ["10", 10_000],
    ["2.5", 2_500],
    ["0.001", 1],
    ["1e3", 1_000_000],
  ])("reads %s seconds as %d ms", (given, milliseconds) => {
    expect(stepLimitMilliseconds({ [stepVariable]: given })).toBe(milliseconds);
  });

  test.each(["0", "-1", "abc", "Infinity", "NaN", " "])(
    "refuses %j and names the repair",
    (given) => {
      expect(() => stepLimitMilliseconds({ [stepVariable]: given })).toThrow(
        `${stepVariable} is '${given}'. Repair: set it to a positive number of seconds, or unset it for 300 s.`,
      );
    },
  );

  test("quotes a single quote in the refused value", () => {
    expect(() => stepLimitMilliseconds({ [stepVariable]: "it's" })).toThrow(
      `${stepVariable} is 'it'\\''s'.`,
    );
  });

  test("reads the given environment, not the process's own", () => {
    const own = process.env[stepVariable];

    expect(stepLimitMilliseconds({ [stepVariable]: "4" })).toBe(4_000);
    expect(process.env[stepVariable]).toBe(own);
  });
});

describe("report", () => {
  const done = "Done when bun run fault-replay abc1234-limit passes.";
  const shown = "bun test ./tests/limit.test.ts -t '^L\\.refuses '";

  async function reported(verdict: Verdict, seconds = 12.34, limit = 2_500) {
    const { result, stdout, stderr } = await captured(() =>
      report(sample, verdict, seconds, limit),
    );
    expect(result).toBeUndefined();
    expect(stderr).toBe("");
    return stdout;
  }

  test("KILLED lists the failing tests in order", async () => {
    expect(await reported({ kind: "KILLED", failing: ["L.a", "L.b"] })).toBe(
      "KILLED abc1234-limit in 12.3 s. Failed: L.a | L.b\n",
    );
  });

  test("UNPARSED names the files, prints the parse output, and gives the repair", async () => {
    expect(
      await reported(
        {
          kind: "UNPARSED",
          files: ["src/limit.ts"],
          output: "src/limit.ts: Unexpected }",
        },
        0.04,
      ),
    ).toBe(
      `UNPARSED abc1234-limit in 0.0 s. src/limit.ts failed to parse with ${sample.patch} applied, so any test would fail for the wrong reason.\n` +
        "src/limit.ts: Unexpected }\n" +
        `Repair: re-plant the fault so the patched file parses. ${done}\n`,
    );
  });

  test("UNMATCHED with another failing test names what failed, prints the output, and gives the repair", async () => {
    expect(
      await reported({
        kind: "UNMATCHED",
        failing: ["Outer > (unnamed)"],
        output: "(fail) Outer > (unnamed)",
      }),
    ).toBe(
      `UNMATCHED abc1234-limit in 12.3 s. ${shown} failed, but no failing test matched '^L\\.refuses '. Failed: Outer > (unnamed).\n` +
        "(fail) Outer > (unnamed)\n" +
        `Repair: re-plant the fault so a test matching '^L\\.refuses ' fails, or update the record's title. ${done}\n`,
    );
  });

  test("UNMATCHED with no failing test says the test file did not load", async () => {
    expect(
      await reported(
        {
          kind: "UNMATCHED",
          failing: [],
          output: "error: boom",
        },
        0.04,
      ),
    ).toBe(
      `UNMATCHED abc1234-limit in 0.0 s. ${shown} failed, but no failing test matched '^L\\.refuses '. Failed: the test file, which did not load.\n` +
        "error: boom\n" +
        `Repair: re-plant the fault so a test matching '^L\\.refuses ' fails, or update the record's title. ${done}\n`,
    );
  });

  test("SURVIVED names the passing command and the repair", async () => {
    expect(await reported({ kind: "SURVIVED" })).toBe(
      `SURVIVED abc1234-limit in 12.3 s. ${shown} passed with ${sample.patch} applied, so no test catches this planted fault.\n` +
        `Repair: change tests/limit.test.ts so that test fails with the patch applied. ${done}\n`,
    );
  });

  test("STALE prints the apply output, then how to plant the fault again", async () => {
    expect(await reported({ kind: "STALE", output: "error: no match" })).toBe(
      `STALE abc1234-limit in 12.3 s. ${sample.patch} no longer applies at this head.\n` +
        "error: no match\n" +
        `Repair: plant the fault again by hand, run git diff -- <each file you edited> > '${sample.patch}', then undo the planted edit. ${done}\n`,
    );
  });

  test("STALE does not add a second newline to output that ends with one", async () => {
    expect(
      await reported({ kind: "STALE", output: "error: no match\n" }),
    ).toContain("applies at this head.\nerror: no match\nRepair: plant");
  });

  test("BROKEN prints the failing output and the repair", async () => {
    expect(await reported({ kind: "BROKEN", output: "(fail) L.red" })).toBe(
      `BROKEN abc1234-limit in 12.3 s. ${shown} fails without the patch, so the planted fault shows nothing.\n` +
        "(fail) L.red\n" +
        `Repair: make that test pass without the patch. ${done}\n`,
    );
  });

  test("BROKEN does not add a second newline to output that ends with one", async () => {
    expect(
      await reported({ kind: "BROKEN", output: "(fail) L.red\n" }),
    ).toContain("shows nothing.\n(fail) L.red\nRepair: make");
  });

  test("TIMEOUT names the step, the limit in seconds and the variable", async () => {
    expect(await reported({ kind: "TIMEOUT", step: "bun install" })).toBe(
      "TIMEOUT abc1234-limit in 12.3 s. bun install did not finish within 2.5 s, so the planted fault has no verdict.\n" +
        `Repair: run that step by hand to see where it hangs, or raise ${stepVariable}. ${done}\n`,
    );
  });

  test("quotes a single quote in the title of the shown command", async () => {
    const { stdout } = await captured(() =>
      report({ ...sample, title: "it's" }, { kind: "SURVIVED" }, 1, 1_000),
    );

    expect(stdout).toContain("-t 'it'\\''s' passed with");
  });
});
