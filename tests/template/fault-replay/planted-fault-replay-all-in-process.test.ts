import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type Fault,
  recordFile,
  recordsPath,
  replayAll,
} from "../../../scripts/planted-faults.ts";
import { readTimings } from "../../../scripts/planted-fault-shards.ts";
import {
  createPlantedFaultFixture,
  guarded,
  headOf,
  limitTests,
  loadThrowingPatch,
  type Planted,
  recorded,
  rejection,
  sample,
  stepVariable,
  unguarded,
  unparseablePatch,
} from "../../support/planted-fault-in-process-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { commit, gitOutput, worktrees } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const { isolated, planted, repository } = createPlantedFaultFixture();

function hashGitTree(root: string): Record<string, string> {
  const entries: [string, string][] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isSymbolicLink())
        entries.push([relative, `symlink:${readlinkSync(full)}`]);
      else
        entries.push([
          relative,
          new Bun.CryptoHasher("sha256")
            .update(readFileSync(full))
            .digest("hex"),
        ]);
    }
  };
  visit(root, "");
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

describe("replayAll", () => {
  const environment = { [stepVariable]: "20" };
  const setupOnlyTimeout = processWatchdog(4);
  const oneFaultTimeout = processWatchdog(14);
  const twoFaultTimeout = processWatchdog(19);

  async function replayedAll(
    root: string,
    ids: readonly string[] = [],
    env: Readonly<Record<string, string | undefined>> = environment,
  ) {
    return isolated(() => replayAll(root, ids, env));
  }

  function killedAndSurvivor(): Planted & { survivor: Fault } {
    const subject = planted();
    const survivor: Fault = {
      ...subject.fault,
      id: "weak",
      title: "^L\\.weak ",
    };
    recorded(subject.root, [subject.fault, survivor]);
    return { ...subject, survivor };
  }

  function twoFaultMarkerFixture(ignored: boolean) {
    const subject = planted({
      tests: `import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { limit } from "../src/limit.ts";

test("L.refuses NaN after writing a file", () => {
  writeFileSync("marker.txt", "left behind\\n");
  expect(() => limit(Number.NaN)).toThrow("limit must be a number");
});
`,
    });
    commit(subject.root, "add second guard expecting clean tree", {
      ...(ignored ? { ".gitignore": "node_modules/\nmarker.txt\n" } : {}),
      "src/other.ts": `export function check(value: number): number {
  if (value < 0) throw new RangeError("must be non-negative");
  return value;
}
`,
      "tests/other.test.ts": `import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { check } from "../src/other.ts";

test("O.refuses negative on a clean tree", () => {
  expect(existsSync("marker.txt")).toBe(false);
  expect(() => check(-1)).toThrow("must be non-negative");
});
`,
    });
    const second: Fault = {
      id: "zzz9999-other",
      patch: "tests/planted-faults/patches/zzz9999-other.patch",
      testFile: "tests/other.test.ts",
      title: "^O\\.refuses ",
      source: "zzz9999 fix: refuse negative",
    };
    write(
      subject.root,
      second.patch,
      `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,4 +1,3 @@
 export function check(value: number): number {
-  if (value < 0) throw new RangeError("must be non-negative");
   return value;
 }
`,
    );
    recorded(subject.root, [subject.fault, second]);
    return { subject, second };
  }

  test(
    "exits 0 and says so when every fault is KILLED",
    async () => {
      const subject = planted();
      recorded(subject.root, [subject.fault]);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(0);
      const [verdict, summary, ...rest] = run.stdout.split("\n");
      expect(verdict).toMatch(
        new RegExp(
          `^KILLED ${subject.id} in [\\d.]+ s\\. Failed: L\\.refuses NaN \\| L\\.refuses NaN twice$`,
        ),
      );
      expect(summary).toMatch(
        new RegExp(
          `^1 of 1 planted faults KILLED in [\\d.]+ s, [\\d.]+ s per fault, with Bun ${Bun.version.replaceAll(".", "\\.")}\\.$`,
        ),
      );
      expect(rest).toEqual([""]);
      expect(run.stderr).toBe("");
      expect(worktrees(subject.root)).toEqual([subject.root]);
      expect(run.leftovers).toEqual([]);
    },
    oneFaultTimeout,
  );

  test(
    "replays every record in order and exits 1 when one survives",
    async () => {
      const { root, id } = killedAndSurvivor();
      let wall = 0;

      const run = await isolated(async () => {
        const began = performance.now();
        try {
          return await replayAll(root, [], environment);
        } finally {
          wall = (performance.now() - began) / 1000;
        }
      });

      expect(run.result).toBe(1);
      const lines = run.stdout.split("\n");
      expect(lines[0]).toStartWith(`KILLED ${id} in `);
      expect(lines[1]).toStartWith("SURVIVED weak in ");
      expect(lines[2]).toBe(
        "Repair: change tests/limit.test.ts so that test fails with the patch applied. Done when bun run fault-replay weak passes.",
      );
      expect(lines[3]).toMatch(
        /^1 of 2 planted faults KILLED in [\d.]+ s, [\d.]+ s per fault, with Bun /,
      );
      expect(run.leftovers).toEqual([]);
      const seconds = (line: string | undefined, after: string) =>
        Number(line?.match(new RegExp(`${after}(\\d+\\.\\d)`))?.[1]);
      const first = seconds(lines[0], " in ");
      const second = seconds(lines[1], " in ");
      const total = seconds(lines[3], "KILLED in ");
      const each = seconds(lines[3], " s, ");
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThanOrEqual(0);
      expect(first + second).toBeLessThanOrEqual(total + 0.2);
      expect(total).toBeLessThanOrEqual(wall + 0.06);
      expect(Math.abs(each * 2 - total)).toBeLessThanOrEqual(0.15);
    },
    twoFaultTimeout,
  );

  test(
    "replays only the records its ids name",
    async () => {
      const { root, id } = killedAndSurvivor();

      const run = await replayedAll(root, [id]);

      expect(run.result).toBe(0);
      expect(run.stdout).not.toContain("SURVIVED");
      expect(run.stdout).toContain("1 of 1 planted faults KILLED in ");
    },
    oneFaultTimeout,
  );

  test(
    "refuses an unknown id before replaying anything",
    async () => {
      const { root, id } = killedAndSurvivor();

      const run = await replayedAll(root, [id, "nope", "gone"]);

      expect(run.result).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(
        `No fault record nope, gone in ${recordsPath}. Repair: pass an id that folder holds.\n`,
      );
      expect(run.leftovers).toEqual([]);
    },
    setupOnlyTimeout,
  );

  test(
    "reports an unknown id before it reads the step limit",
    async () => {
      const { root } = killedAndSurvivor();

      const run = await replayedAll(root, ["nope"], { [stepVariable]: "x" });

      expect(run.result).toBe(2);
      expect(run.stderr).toContain("No fault record nope in ");
    },
    setupOnlyTimeout,
  );

  test.each([
    ["no records folder", null],
    ["an empty records folder", ".DS_Store"],
  ])(
    "exits 1 and says it checks nothing with %s",
    async (_name, hidden) => {
      const root = repository("planted-faults-empty-");
      commit(root, "base", { "package.json": "{}" });
      if (hidden !== null) write(root, `${recordsPath}/${hidden}`, "");

      const run = await replayedAll(root);

      expect(run.result).toBe(1);
      expect(run.stdout).toBe(
        `${recordsPath} has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.\n`,
      );
      expect(run.stderr).toBe("");
    },
    setupOnlyTimeout,
  );

  test(
    "refuses a step limit that is not a positive number",
    async () => {
      const subject = planted();
      recorded(subject.root, [subject.fault]);

      const run = replayedAll(subject.root, [], { [stepVariable]: "-3" });

      expect(await rejection(run)).toBe(
        `${stepVariable} is '-3'. Repair: set it to a positive number of seconds, or unset it for 300 s.`,
      );
    },
    setupOnlyTimeout,
  );

  test(
    "reports TIMEOUT with the limit in seconds and exits 1",
    async () => {
      const subject = planted();
      recorded(subject.root, [subject.fault]);

      const run = await replayedAll(subject.root, [], {
        [stepVariable]: "0.001",
      });

      expect(run.result).toBe(1);
      expect(run.stdout).toContain(
        "did not finish within 0.001 s, so the planted fault has no verdict.",
      );
      expect(run.stdout).toContain("0 of 1 planted faults KILLED in ");
      expect(run.leftovers).toEqual([]);
    },
    setupOnlyTimeout,
  );

  test(
    "replays uncommitted and untracked work, leaving the tree as it was",
    async () => {
      const root = repository("planted-faults-dirty-");
      commit(root, "base", {
        "package.json": JSON.stringify({ name: "fixture", private: true }),
        ".gitignore": "node_modules/\n",
        "src/limit.ts": unguarded,
      });
      const fault: Fault = {
        ...sample,
        id: "dirty-limit",
        patch: "tests/planted-faults/patches/dirty-limit.patch",
      };
      write(root, "src/limit.ts", guarded);
      write(
        root,
        fault.patch,
        gitOutput(root, "diff", "-R", "--", "src/limit.ts"),
      );
      write(root, "tests/limit.test.ts", limitTests);
      write(root, recordFile(fault.id), `${JSON.stringify(fault, null, 2)}\n`);
      const head = headOf(root);
      const status = gitOutput(root, "status", "--porcelain");

      const run = await replayedAll(root);

      expect(run.result).toBe(0);
      expect(run.stdout).toContain(`KILLED ${fault.id} in `);
      expect(headOf(root)).toBe(head);
      expect(gitOutput(root, "status", "--porcelain")).toBe(status);
      expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(guarded);
      expect(run.leftovers).toEqual([]);
    },
    oneFaultTimeout,
  );

  test(
    "replays a clean tree at its own head",
    async () => {
      const subject = planted();
      recorded(subject.root, [subject.fault]);
      const head = headOf(subject.root);
      const objects = gitOutput(subject.root, "count-objects");

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(0);
      expect(headOf(subject.root)).toBe(head);
      expect(gitOutput(subject.root, "status", "--porcelain")).toBe("");
      expect(gitOutput(subject.root, "count-objects")).toBe(objects);
    },
    oneFaultTimeout,
  );

  test(
    "reports UNPARSED with the repair line and exits 1",
    async () => {
      const subject = planted();
      write(subject.root, subject.fault.patch, unparseablePatch);
      recorded(subject.root, [subject.fault]);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(1);
      expect(run.stdout).toMatch(
        new RegExp(
          `^UNPARSED ${subject.id} in [\\d.]+ s\\. src/limit\\.ts failed to parse with ${subject.fault.patch.replaceAll(".", "\\.")} applied, so any test would fail for the wrong reason\\.`,
        ),
      );
      expect(run.stdout).toContain(
        `Repair: re-plant the fault so the patched file parses. Done when bun run fault-replay ${subject.id} passes.`,
      );
      expect(run.stdout).toContain("0 of 1 planted faults KILLED in ");
      expect(run.leftovers).toEqual([]);
    },
    oneFaultTimeout,
  );

  test(
    "reports UNMATCHED with the repair line and exits 1",
    async () => {
      const subject = planted();
      write(subject.root, subject.fault.patch, loadThrowingPatch);
      recorded(subject.root, [subject.fault]);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(1);
      expect(run.stdout).toMatch(
        new RegExp(
          `^UNMATCHED ${subject.id} in [\\d.]+ s\\. bun test \\./tests/limit\\.test\\.ts -t '\\^L\\\\\\.refuses ' failed, but no failing test matched '\\^L\\\\\\.refuses '\\. Failed: the test file, which did not load\\.`,
        ),
      );
      expect(run.stdout).toContain(
        `Repair: re-plant the fault so a test matching '^L\\.refuses ' fails, or update the record's title. Done when bun run fault-replay ${subject.id} passes.`,
      );
      expect(run.stdout).toContain("0 of 1 planted faults KILLED in ");
      expect(run.leftovers).toEqual([]);
    },
    oneFaultTimeout,
  );

  test(
    "does not write any worktree or git object under the checkout's .git, even when dirty",
    async () => {
      const subject = planted();
      recorded(subject.root, [subject.fault]);
      write(subject.root, "untracked.txt", "dirty\n");
      const gitDir = join(subject.root, ".git");
      const gitBefore = hashGitTree(gitDir);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(0);
      expect(run.stdout).toContain(`KILLED ${subject.id} in `);
      expect(hashGitTree(gitDir)).toEqual(gitBefore);
      expect(worktrees(subject.root)).toEqual([subject.root]);
      expect(run.leftovers).toEqual([]);
    },
    oneFaultTimeout,
  );

  test(
    "gives KILLED to a fault whose test runs git on the replayed tree",
    async () => {
      const subject = planted({
        tests: `import { expect, test } from "bun:test";
import { limit } from "../src/limit.ts";

test("L.refuses NaN with git", () => {
  const status = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 4_000,
    killSignal: "SIGKILL",
  });
  expect(status.exitedDueToTimeout).toBe(false);
  expect(status.exitCode).toBe(0);
  expect(status.stdout.toString().trim().startsWith("true\\n")).toBe(true);
  expect(() => limit(Number.NaN)).toThrow("limit must be a number");
});
`,
      });
      recorded(subject.root, [subject.fault]);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(0);
      expect(run.stdout).toContain(`KILLED ${subject.id} in `);
      expect(run.leftovers).toEqual([]);
    },
    oneFaultTimeout,
  );

  test(
    "restores patched files between faults so a later fault does not see an earlier patch",
    async () => {
      const subject = planted();
      commit(subject.root, "add second guard", {
        "src/other.ts": `export function check(value: number): number {
  if (value < 0) throw new RangeError("must be non-negative");
  return value;
}
`,
        "tests/other.test.ts": `import { expect, test } from "bun:test";
import { limit } from "../src/limit.ts";
import { check } from "../src/other.ts";

test("O.refuses negative while limit still refuses NaN", () => {
  expect(() => limit(Number.NaN)).toThrow("limit must be a number");
  expect(() => check(-1)).toThrow("must be non-negative");
});
`,
      });
      const second: Fault = {
        id: "zzz9999-other",
        patch: "tests/planted-faults/patches/zzz9999-other.patch",
        testFile: "tests/other.test.ts",
        title: "^O\\.refuses ",
        source: "zzz9999 fix: refuse negative",
      };
      write(
        subject.root,
        second.patch,
        `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,4 +1,3 @@
 export function check(value: number): number {
-  if (value < 0) throw new RangeError("must be non-negative");
   return value;
 }
`,
      );
      recorded(subject.root, [subject.fault, second]);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(0);
      expect(run.stdout).toContain(`KILLED ${subject.id} in `);
      expect(run.stdout).toContain(`KILLED ${second.id} in `);
      expect(run.stdout).toContain("2 of 2 planted faults KILLED in ");
      expect(run.leftovers).toEqual([]);
    },
    twoFaultTimeout,
  );

  test(
    "resets test-created files between faults so a later fault keeps its verdict",
    async () => {
      const { subject, second } = twoFaultMarkerFixture(false);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(0);
      expect(run.stdout).toContain(`KILLED ${subject.id} in `);
      expect(run.stdout).toContain(`KILLED ${second.id} in `);
      expect(run.stdout).toContain("2 of 2 planted faults KILLED in ");
      expect(run.leftovers).toEqual([]);
    },
    twoFaultTimeout,
  );

  test(
    "resets gitignored test-created files between faults so a later fault keeps its verdict",
    async () => {
      const { subject, second } = twoFaultMarkerFixture(true);

      const run = await replayedAll(subject.root);

      expect(run.result).toBe(0);
      expect(run.stdout).toContain(`KILLED ${subject.id} in `);
      expect(run.stdout).toContain(`KILLED ${second.id} in `);
      expect(run.stdout).toContain("2 of 2 planted faults KILLED in ");
      expect(run.leftovers).toEqual([]);
    },
    twoFaultTimeout,
  );

  test(
    "refreshes recorded timings for KILLED faults only when updateTimings is enabled",
    async () => {
      const { root, id, survivor } = killedAndSurvivor();

      const run = await isolated(() =>
        replayAll(root, [], environment, { updateTimings: true }),
      );

      expect(run.result).toBe(1);
      const timings = readTimings(root);
      expect(timings.get(id)).toBeGreaterThan(0);
      expect(timings.has(survivor.id)).toBe(false);
    },
    twoFaultTimeout,
  );
});
