import { describe, expect, test } from "bun:test";
import {
  type Fault,
  replay,
  type Verdict,
} from "../../../scripts/planted-faults.ts";
import {
  createPlantedFaultFixture,
  guarded,
  headOf,
  loadThrowingPatch,
  type Planted,
  unparseablePatch,
} from "../../support/planted-fault-in-process-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { commit, worktrees } from "../../support/git-fixture.ts";

const { isolated, planted } = createPlantedFaultFixture();

function outputOf(verdict: Verdict): string {
  if (
    verdict.kind === "STALE" ||
    verdict.kind === "BROKEN" ||
    verdict.kind === "UNPARSED" ||
    verdict.kind === "UNMATCHED"
  )
    return verdict.output;
  throw new Error(`${verdict.kind} carries no output.`);
}

describe("replay", () => {
  const limit = 120_000;

  async function replayed(subject: Planted, overrides: Partial<Fault> = {}) {
    return isolated(() =>
      replay(
        subject.root,
        { ...subject.fault, ...overrides },
        headOf(subject.root),
        limit,
      ),
    );
  }

  test("UNPARSED when the patch leaves a TypeScript file unparseable", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, unparseablePatch);
    const parserSays = (() => {
      try {
        new Bun.Transpiler({ loader: "ts" }).transformSync(`${guarded}});\n`);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("Bun.Transpiler accepted a stray '});'.");
    })();

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "UNPARSED",
      files: ["src/limit.ts"],
      output: `src/limit.ts: ${parserSays}`,
    });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("UNPARSED when the patch leaves an MJS file unparseable", async () => {
    const subject = planted();
    const valid = "export function ok() {\n  return 1;\n}\n";
    commit(subject.root, "add module", { "src/helper.mjs": valid });
    write(
      subject.root,
      subject.fault.patch,
      `diff --git a/src/helper.mjs b/src/helper.mjs
--- a/src/helper.mjs
+++ b/src/helper.mjs
@@ -1,3 +1,4 @@
 export function ok() {
   return 1;
 }
+});
`,
    );
    const parserSays = (() => {
      try {
        new Bun.Transpiler({ loader: "js" }).transformSync(`${valid}});\n`);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("Bun.Transpiler accepted a stray '});'.");
    })();

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "UNPARSED",
      files: ["src/helper.mjs"],
      output: `src/helper.mjs: ${parserSays}`,
    });
  }, 60_000);

  test("UNPARSED when the patch leaves a JSON file unparseable", async () => {
    const subject = planted();
    commit(subject.root, "add config", {
      "src/config.json": '{\n  "max": 10\n}\n',
    });
    write(
      subject.root,
      subject.fault.patch,
      `diff --git a/src/config.json b/src/config.json
--- a/src/config.json
+++ b/src/config.json
@@ -1,3 +1,3 @@
 {
-  "max": 10
+  "max": 10,
 }
`,
    );
    const parserSays = (() => {
      try {
        JSON.parse('{\n  "max": 10,\n}\n');
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("JSON.parse accepted trailing comma.");
    })();

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "UNPARSED",
      files: ["src/config.json"],
      output: `src/config.json: ${parserSays}`,
    });
  }, 60_000);

  test("UNMATCHED when the patched module throws on load and no named test fails", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, loadThrowingPatch);

    const run = await replayed(subject);

    expect(run.result.kind).toBe("UNMATCHED");
    expect(Reflect.get(run.result, "failing")).toEqual([]);
    expect(outputOf(run.result)).toContain("module failed to load");
  }, 60_000);

  test("UNMATCHED when the run fails on a name that does not match the record's title", async () => {
    const subject = planted({
      tests: `import { afterAll, describe, expect, test } from "bun:test";
import { limit } from "../src/limit.ts";

describe("Outer", () => {
  afterAll(() => {
    expect(() => limit(Number.NaN)).toThrow("limit must be a number");
  });
  test("L.refuses NaN", () => {
    expect(limit(1)).toBe(1);
  });
});
`,
      title: "^Outer L\\.refuses ",
    });

    const run = await replayed(subject);

    expect(run.result.kind).toBe("UNMATCHED");
    expect(Reflect.get(run.result, "failing")).toEqual(["Outer > (unnamed)"]);
    expect(outputOf(run.result)).toContain("(fail) Outer > (unnamed)");
  }, 60_000);

  test("KILLED when a nested describe and test name matches the record's title", async () => {
    const subject = planted({
      tests: `import { describe, expect, test } from "bun:test";
import { limit } from "../src/limit.ts";

describe("Outer", () => {
  test("L.refuses NaN", () => {
    expect(() => limit(Number.NaN)).toThrow("limit must be a number");
  });
});
`,
      title: "^Outer L\\.refuses NaN$",
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "KILLED",
      failing: ["Outer > L.refuses NaN"],
    });
  }, 60_000);
});
