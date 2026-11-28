import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  readRecords,
  recordFile,
  recordsPath,
} from "../../../scripts/planted-faults.ts";
import { readTimings } from "../../../scripts/planted-fault-shards.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import {
  createPlantedFaultFixture,
  addFault,
  expectNoLeftovers,
  guarded,
  lineOf,
  refusalTest,
  tests,
  timeout,
  verdicts,
} from "../../support/planted-fault-fixture.ts";
import { gitOutput, commit } from "../../support/git-fixture.ts";

const { faultReplay, folder, repositoryWithFault } =
  createPlantedFaultFixture();

function recordTexts(root: string): Record<string, string> {
  const folder = join(root, recordsPath);
  return Object.fromEntries(
    readdirSync(folder).map((name) => [
      name,
      readFileSync(join(folder, name), "utf8"),
    ]),
  );
}

describe("bun run fault-replay", () => {
  test(
    "FR.a planted-fault:add stores the fix's reverse hunk, and the fault is KILLED with exit 0",
    async () => {
      const { root, fix, id, killed } = await repositoryWithFault({});
      expect(killed).toEqual({
        id,
        patch: `tests/planted-faults/patches/${id}.patch`,
        testFile: "tests/limit.test.ts",
        title: "^L\\.refuses ",
        source: `${fix} fix: refuse a NaN limit`,
      });
      expect(readFileSync(join(root, killed.patch), "utf8")).toBe(
        gitOutput(root, "diff", "HEAD~1", "HEAD~2", "--", "src/limit.ts"),
      );
      const run = await faultReplay(root);
      expect(verdicts(run.lines)).toEqual([`KILLED ${id}`]);
      expect(lineOf(run.lines, "KILLED")).toMatch(
        new RegExp(`^KILLED ${id} in [\\d.]+ s\\. Failed: L\\.refuses NaN$`),
      );
      expect(lineOf(run.lines, "1 of 1 planted faults KILLED in ")).toMatch(
        /s per fault, with Bun /,
      );
      expect(run.exit).toBe(0);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.b a fault the named test misses is SURVIVED, named with its rerun, and exits 1",
    async () => {
      const { root, id } = await repositoryWithFault({
        weak: "^L\\.weak ",
      });
      const run = await faultReplay(root);
      expect(verdicts(run.lines)).toEqual([`KILLED ${id}`, "SURVIVED weak"]);
      expect(run.lines).toContain(
        "Repair: change tests/limit.test.ts so that test fails with the patch applied. Done when bun run fault-replay weak passes.",
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.c a patch that no longer applies is STALE by id, and exits 1",
    async () => {
      const { root, id } = await repositoryWithFault({});
      commit(root, "reword the refusal", {
        "src/limit.ts": guarded.replace("must be", "has to be"),
        "tests/limit.test.ts": tests(
          refusalTest.replace("must be", "has to be"),
        ),
      });
      const run = await faultReplay(root, [id]);
      expect(verdicts(run.lines)).toEqual([`STALE ${id}`]);
      expect(lineOf(run.lines, "STALE")).toMatch(
        new RegExp(
          `^STALE ${id} in [\\d.]+ s\\. tests/planted-faults/patches/${id}\\.patch no longer applies at this head\\.$`,
        ),
      );
      expect(run.lines).toContain(
        `Repair: plant the fault again by hand, run git diff -- <each file you edited> > 'tests/planted-faults/patches/${id}.patch', then undo the planted edit. Done when bun run fault-replay ${id} passes.`,
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.d a test that fails without the fault is BROKEN, not KILLED, and exits 1",
    async () => {
      const { root } = await repositoryWithFault({ red: "^L\\.red " });
      const run = await faultReplay(root, ["red"]);
      expect(verdicts(run.lines)).toEqual(["BROKEN red"]);
      expect(lineOf(run.lines, "BROKEN")).toMatch(
        /^BROKEN red in [\d.]+ s\. bun test \.\/tests\/limit\.test\.ts -t '\^L\\\.red ' fails without the patch, so the planted fault shows nothing\.$/,
      );
      expect(run.lines).toContain(
        "Repair: make that test pass without the patch. Done when bun run fault-replay red passes.",
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.d2 a patch that leaves a file unparseable is UNPARSED, not KILLED, and exits 1",
    async () => {
      const { root, id, killed } = await repositoryWithFault({});
      commit(root, "plant an unparseable fault", {
        [killed.patch]: `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,4 +1,5 @@
 export function limit(value: number): number {
   if (Number.isNaN(value)) throw new TypeError("limit must be a number");
   return value;
 }
+});
`,
      });
      const run = await faultReplay(root, [id]);
      expect(verdicts(run.lines)).toEqual([`UNPARSED ${id}`]);
      expect(lineOf(run.lines, "UNPARSED")).toMatch(
        new RegExp(
          `^UNPARSED ${id} in [\\d.]+ s\\. src/limit\\.ts failed to parse with ${killed.patch.replaceAll(".", "\\.")} applied, so any test would fail for the wrong reason\\.$`,
        ),
      );
      expect(run.lines).toContain(
        `Repair: re-plant the fault so the patched file parses. Done when bun run fault-replay ${id} passes.`,
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.d3 a patch that fails the test file on load is UNMATCHED, not KILLED, and exits 1",
    async () => {
      const { root, id, killed } = await repositoryWithFault({});
      commit(root, "plant a load-throwing fault", {
        [killed.patch]: `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,3 +1,4 @@
+throw new Error("module failed to load");
 export function limit(value: number): number {
   if (Number.isNaN(value)) throw new TypeError("limit must be a number");
   return value;
`,
      });
      const run = await faultReplay(root, [id]);
      expect(verdicts(run.lines)).toEqual([`UNMATCHED ${id}`]);
      expect(lineOf(run.lines, "UNMATCHED")).toMatch(
        new RegExp(
          `^UNMATCHED ${id} in [\\d.]+ s\\. bun test \\./tests/limit\\.test\\.ts -t '\\^L\\\\\\.refuses ' failed, but no failing test matched '\\^L\\\\\\.refuses '\\. Failed: the test file, which did not load\\.$`,
        ),
      );
      expect(run.lines).toContain(
        `Repair: re-plant the fault so a test matching '^L\\.refuses ' fails, or update the record's title. Done when bun run fault-replay ${id} passes.`,
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.e an id no fault record has is refused with exit 2 and runs nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      const run = await faultReplay(root, ["missing"]);
      expect(run.stderr).toBe(
        "No fault record missing in tests/planted-faults/fault-records. Repair: pass an id that folder holds.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(2);
    },
    timeout,
  );

  test(
    "FR.t an empty list of fault records replays nothing and fails, saying the gate checks nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      rmSync(join(root, recordsPath), { recursive: true });
      const run = await faultReplay(root, []);
      expect(run.lines).toContain(
        "tests/planted-faults/fault-records has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(1);
    },
    timeout,
  );

  test(
    "FR.u --changed-since replays only the faults whose patch touches a changed file, and passes when none does",
    async () => {
      const { root, id } = await repositoryWithFault({});
      const base = gitOutput(root, "rev-parse", "HEAD").trim();
      commit(root, "notes", { "README.md": "notes\n" });
      const untouched = await faultReplay(root, ["--changed-since", base]);
      expect(untouched.lines).toContain(
        `No planted fault patches a file changed since ${base.slice(0, 7)}, so there is nothing to replay.`,
      );
      expect(verdicts(untouched.lines)).toEqual([]);
      expect(untouched.exit).toBe(0);
      commit(root, "reword the refusal", {
        "src/limit.ts": guarded.replace("must be", "has to be"),
        "tests/limit.test.ts": tests(
          refusalTest.replace("must be", "has to be"),
        ),
      });
      const touched = await faultReplay(root, ["--changed-since", base]);
      expect(verdicts(touched.lines)).toEqual([`STALE ${id}`]);
      expect(touched.exit).toBe(1);
      expectNoLeftovers(root, touched.temporary);
    },
    timeout,
  );

  test(
    "FR.w --changed-since with an empty list of fault records fails, saying the gate checks nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      const base = gitOutput(root, "rev-parse", "HEAD").trim();
      gitOutput(root, "rm", "--quiet", "-r", "--", recordsPath);
      gitOutput(root, "commit", "--quiet", "-m", "drop the records");
      const run = await faultReplay(root, ["--changed-since", base]);
      expect(run.lines).toContain(
        "tests/planted-faults/fault-records has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.",
      );
      expect(run.exit).toBe(1);
    },
    timeout,
  );

  test(
    "FR.x --changed-since run from a hook that exports another repository's git location reads its own repository",
    async () => {
      const { root, id } = await repositoryWithFault({});
      const base = gitOutput(root, "rev-parse", "HEAD").trim();
      commit(root, "reword the refusal", {
        "src/limit.ts": guarded.replace("must be", "has to be"),
        "tests/limit.test.ts": tests(
          refusalTest.replace("must be", "has to be"),
        ),
      });
      const caller = join(folder("fault-replay-caller-"), "repo");
      mkdirSync(caller);
      gitOutput(caller, "init", "--quiet", "--initial-branch=main");
      commit(caller, "caller", { "caller.txt": "caller\n" });
      const callerHead = gitOutput(caller, "rev-parse", "HEAD").trim();
      const hook = {
        GIT_DIR: join(caller, ".git"),
        GIT_WORK_TREE: caller,
        GIT_INDEX_FILE: join(caller, ".git", "index"),
        GIT_OBJECT_DIRECTORY: join(caller, ".git", "objects"),
        GIT_COMMON_DIR: join(caller, ".git"),
      };

      const run = await faultReplay(root, ["--changed-since", base], {
        env: hook,
      });

      expect(run.stderr).toBe("");
      expect(verdicts(run.lines)).toEqual([`STALE ${id}`]);
      expect(run.exit).toBe(1);
      expect(gitOutput(caller, "rev-parse", "HEAD").trim()).toBe(callerHead);
      expect(gitOutput(caller, "status", "--porcelain")).toBe("");
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.v --changed-since with no base, or more than one, is a usage error with exit 2",
    async () => {
      const { root } = await repositoryWithFault({});
      for (const args of [
        ["--changed-since"],
        ["--changed-since", "HEAD", "HEAD"],
      ]) {
        const run = await faultReplay(root, args);
        expect(run.stderr).toBe(
          "Usage: bun run fault-replay --changed-since <base>\n",
        );
        expect(verdicts(run.lines)).toEqual([]);
        expect(run.exit).toBe(2);
      }
    },
    timeout,
  );

  test(
    "FR.z --shard replays only its part, and the part that holds a SURVIVED fault exits 1",
    async () => {
      const { root, id } = await repositoryWithFault({ weak: "^L\\.weak " });
      const first = await faultReplay(root, ["--shard", "1/2"]);
      const second = await faultReplay(root, ["--shard", "2/2"]);
      expect(verdicts(first.lines)).toEqual([`KILLED ${id}`]);
      expect(first.exit).toBe(0);
      expect(verdicts(second.lines)).toEqual(["SURVIVED weak"]);
      expect(second.exit).toBe(1);
      expectNoLeftovers(root, second.temporary);
    },
    timeout,
  );

  test(
    "FR.o --shard past its parts is refused with exit 2 and runs nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      const run = await faultReplay(root, ["--shard", "3/2"]);
      expect(run.stderr).toBe(
        "Usage: bun run fault-replay --shard <part>/<parts> [--tooling-changed-since <base>] [--update-timings], with whole numbers 1 <= part <= parts. Got '--shard 3/2'. Repair: pass one part, such as --shard 2/4.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(2);
    },
    timeout,
  );

  test(
    "FR.g --tooling-changed-since skips a tooling fault its test file leaves untouched, and replays it once that file changes",
    async () => {
      const { root, id } = await repositoryWithFault({});
      const toolingTest = tests(refusalTest).replace(
        '"../src/limit.ts"',
        '"../../src/limit.ts"',
      );
      const [killed] = readRecords(root);
      commit(root, "record a tooling fault", {
        "tests/template/limit.test.ts": toolingTest,
        [recordFile("tooling")]: `${JSON.stringify(
          {
            ...killed,
            id: "tooling",
            testFile: "tests/template/limit.test.ts",
          },
          null,
          2,
        )}\n`,
      });
      const untouched = await faultReplay(root, [
        "--shard",
        "1/1",
        "--tooling-changed-since",
        "HEAD",
      ]);
      expect(verdicts(untouched.lines)).toEqual([`KILLED ${id}`]);
      expect(untouched.exit).toBe(0);
      commit(root, "touch the tooling test", {
        "tests/template/limit.test.ts": `${toolingTest}\n`,
      });
      const touched = await faultReplay(root, [
        "--shard",
        "1/1",
        "--tooling-changed-since",
        "HEAD~1",
      ]);
      expect(verdicts(touched.lines)).toEqual([
        `KILLED ${id}`,
        "KILLED tooling",
      ]);
      expect(touched.exit).toBe(0);
      expectNoLeftovers(root, touched.temporary);
    },
    timeout,
  );

  test(
    "FR.i planted-fault:add refuses a source path the fix does not change, and writes nothing",
    async () => {
      const { root, fix } = await repositoryWithFault({});
      const before = recordTexts(root);
      const added = await addFault(root, fix, "package.json");
      expect(added.stderr).toBe(
        `${fix} does not change package.json. Repair: pass a path that git diff --name-only ${fix}^ ${fix} lists.\n`,
      );
      expect(added.exit).toBe(2);
      expect(recordTexts(root)).toEqual(before);
      expect(readdirSync(join(root, "tests/planted-faults/patches"))).toEqual([
        `${fix}-limit.patch`,
      ]);
    },
    timeout,
  );

  for (const [field, testFile, title, refusal] of [
    [
      "an empty title",
      "tests/limit.test.ts",
      "",
      "planted-fault:add needs a non-empty string title. Repair: name the bun test -t pattern that selects the test that kills the planted fault.",
    ],
    [
      "a missing test file",
      "tests/missing.test.ts",
      "^L\\.refuses ",
      "planted-fault:add names testFile tests/missing.test.ts, which does not exist. Repair: name a test file relative to the repository root.",
    ],
  ] as const)
    test(
      `FR.m planted-fault:add refuses ${field} by name with its fix, and writes nothing`,
      async () => {
        const { root, id } = await repositoryWithFault({});
        const reworded = commit(root, "fix: reword the refusal", {
          "src/limit.ts": guarded.replace("must be", "has to be"),
          "tests/limit.test.ts": tests(
            refusalTest.replace("must be", "has to be"),
          ),
        });
        const before = recordTexts(root);
        const added = await addFault(
          root,
          reworded,
          "src/limit.ts",
          testFile,
          title,
        );
        expect(added.stderr).toBe(`${refusal}\n`);
        expect(added.exit).toBe(2);
        expect(recordTexts(root)).toEqual(before);
        expect(readdirSync(join(root, "tests/planted-faults/patches"))).toEqual(
          [`${id}.patch`],
        );
      },
      processWatchdog(2),
    );

  test(
    "FR.q a step limit that is not a positive number is refused with exit 2 and runs nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      const run = await faultReplay(root, [], {
        env: { FAULT_REPLAY_STEP_SECONDS: "0" },
      });
      expect(run.stderr).toBe(
        "FAULT_REPLAY_STEP_SECONDS is '0'. Repair: set it to a positive number of seconds up to 2147483, or unset it for 300 s.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(2);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.aa --update-timings refreshes the timing file for each KILLED fault",
    async () => {
      const { root, id } = await repositoryWithFault({});
      const run = await faultReplay(root, [
        "--shard",
        "1/1",
        "--update-timings",
      ]);
      expect(run.exit).toBe(0);
      expect(verdicts(run.lines)).toEqual([`KILLED ${id}`]);
      expect(readTimings(root).get(id)).toBeGreaterThan(0);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.ab unknown command prints usage naming --update-timings and exits 2",
    async () => {
      const script = join(
        import.meta.dir,
        "../../../scripts/planted-faults.ts",
      );
      const run = await spawnBounded([process.execPath, script, "unknown"]);
      expect(run.exit).toBe(2);
      expect(run.stderr).toBe(
        "Usage: bun run fault-replay [--update-timings] [id ...] | bun run fault-replay --changed-since <base> [--update-timings] | bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
      );
    },
    processWatchdog(5),
  );
});
