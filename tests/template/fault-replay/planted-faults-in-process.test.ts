import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Fault,
  replay,
  replayAll,
  type Verdict,
} from "../../../scripts/planted-faults.ts";
import {
  commit,
  createPlantedFaultFixture,
  git,
  guarded,
  headOf,
  limitTests,
  type Planted,
  recorded,
  recordsPath,
  rejection,
  sample,
  stepVariable,
  unguarded,
  worktrees,
  write,
} from "../../support/planted-fault-in-process-fixture.ts";

const { isolated, planted, repository } = createPlantedFaultFixture();

const killedBy = ["L.refuses NaN", "L.refuses NaN twice"];

const redTest = `test("L.red is red without the fault", () => {
  expect(limit(1)).toBe(2);
});
`;

const guardLine =
  'if (Number.isNaN(value)) throw new TypeError("limit must be a number");';

const insertion = `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,3 +1,4 @@
 export function limit(value: number): number {
+  if (Number.isNaN(value)) return value;
   ${guardLine}
   return value;
`;

const twoRegions = `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,4 +1,3 @@
 export function limit(value: number): number {
-  ${guardLine}
   return value;
-}
+};
`;

function ambiguous(places: string, count = 2): string {
  return `anchor ambiguous: the removed text of hunk 1, starting "${guardLine}", is at ${count} places: ${places}. Its context lines do not choose one, and a planted fault in the wrong place still fails its test, so it was not applied.`;
}

function renamed(root: string, extra: Record<string, string> = {}): void {
  git(root, "mv", "src/limit.ts", "src/bound.ts");
  commit(root, "rename limit to bound", {
    "tests/limit.test.ts": limitTests.replace(
      "../src/limit.ts",
      "../src/bound.ts",
    ),
    ...extra,
  });
}

function outputOf(verdict: Verdict): string {
  if (verdict.kind === "STALE" || verdict.kind === "BROKEN")
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

  test("KILLED lists, in file order, every test that fails once the fault is applied", async () => {
    const subject = planted();

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
    expect(run.stdout).toBe("");
  }, 60_000);

  test("SURVIVED when the named test still passes with the fault applied", async () => {
    const subject = planted();

    const run = await replayed(subject, { title: "^L\\.weak " });

    expect(run.result).toEqual({ kind: "SURVIVED" });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("KILLED when the guarded line's neighbours changed after the patch was made", async () => {
    const subject = planted();
    commit(subject.root, "return the number", {
      "src/limit.ts": guarded.replace("return value;", "return Number(value);"),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("KILLED in the tracked file its guarded text moved to", async () => {
    const subject = planted();
    renamed(subject.root);

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("STALE anchor ambiguous, naming each place, when its moved guarded text is in two tracked files", async () => {
    const subject = planted();
    renamed(subject.root, { "src/copy.ts": guarded });
    const status = git(subject.root, "status", "--porcelain");

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: ambiguous("src/bound.ts:2, src/copy.ts:2"),
    });
    expect(git(subject.root, "status", "--porcelain")).toBe(status);
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("STALE anchor ambiguous when its guarded text and context occur twice in its file", async () => {
    const subject = planted();
    commit(subject.root, "show the source", {
      "src/limit.ts": `${guarded}\nexport const shown = \`\n${guarded}\`;\n`,
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: ambiguous("src/limit.ts:2, src/limit.ts:8"),
    });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test.each([
    [10, ""],
    [11, ", and 1 more"],
  ])(
    "STALE anchor ambiguous at %i places names at most ten of them",
    async (count, more) => {
      const subject = planted();
      const copies = Array.from(
        { length: count - 1 },
        (_, index) => `\nexport const shown${index} = \`\n${guarded}\`;\n`,
      );
      const text = [guarded, ...copies].join("");
      commit(subject.root, "show the source", { "src/limit.ts": text });
      const lines = text.split("\n");
      const places = lines.flatMap((line, index) =>
        line === `  ${guardLine}` ? [`src/limit.ts:${index + 1}`] : [],
      );

      const run = await replayed(subject);

      expect(places).toHaveLength(count);
      expect(run.result).toEqual({
        kind: "STALE",
        output: ambiguous(`${places.slice(0, 10).join(", ")}${more}`, count),
      });
    },
    60_000,
  );

  test("KILLED where its context lines choose one of two places holding its guarded text", async () => {
    const subject = planted();
    const copy = guarded.replace("function limit", "function shown");
    commit(subject.root, "show the source", {
      "src/limit.ts": `${guarded}\nexport const shown = \`\n${copy}\`;\n`,
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  function twoPlaces(
    first: { head: string; tail: string },
    second: { head: string; tail: string },
  ): string {
    const place = (name: string, { head, tail }: typeof first) =>
      guarded
        .replace("function limit", `function ${name}`)
        .replace("number {", head)
        .replace("return value;", tail);
    return `${place("limit", first)}\n${place("shown", second)}`;
  }

  const drifted = "number | string {";

  test("KILLED where only the line after its guarded text chooses one of two places, though the line before drifted at both", async () => {
    const subject = planted();
    commit(subject.root, "widen and show", {
      "src/limit.ts": twoPlaces(
        { head: drifted, tail: "return value;" },
        { head: drifted, tail: "return Number(value);" },
      ),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test.each([
    [
      "no side separates them",
      { head: drifted, tail: "return value;" },
      { head: drifted, tail: "return value;" },
    ],
    [
      "each side prefers a different place",
      { head: "number {", tail: "return Number(value);" },
      { head: drifted, tail: "return value;" },
    ],
  ])(
    "STALE anchor ambiguous when %s",
    async (_name, first, second) => {
      const subject = planted();
      commit(subject.root, "show the source", {
        "src/limit.ts": twoPlaces(first, second),
      });

      const run = await replayed(subject);

      expect(run.result).toEqual({
        kind: "STALE",
        output: ambiguous("src/limit.ts:2, src/limit.ts:7"),
      });
    },
    60_000,
  );

  test("STALE anchor absent when the guarded line itself was edited", async () => {
    const subject = planted();
    commit(subject.root, "reword the refusal", {
      "src/limit.ts": guarded.replace("must be", "has to be"),
      "tests/limit.test.ts": limitTests.replaceAll("must be", "has to be"),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: `anchor absent: the removed text of hunk 1, starting "${guardLine}", is not in src/limit.ts or any other tracked file.`,
    });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("KILLED when a patch only inserts lines and its context is in place", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, insertion);

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("KILLED when only the context between a hunk's two changed regions was edited", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, twoRegions);
    commit(subject.root, "return the number", {
      "src/limit.ts": guarded.replace("return value;", "return Number(value);"),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("STALE anchor absent when a patch only inserts lines and its file moved", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, insertion);
    renamed(subject.root);

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output:
        'anchor absent: the context of hunk 1, starting "export function limit(value: number): number {", is not in src/limit.ts.',
    });
  }, 60_000);

  test.each([
    [
      "creates",
      `diff --git a/src/extra.ts b/src/extra.ts
new file mode 100644
--- /dev/null
+++ b/src/extra.ts
@@ -0,0 +1 @@
+export const extra = 1;
`,
    ],
    [
      "deletes",
      `diff --git a/src/limit.ts b/src/limit.ts
deleted file mode 100644
--- a/src/limit.ts
+++ /dev/null
@@ -1,4 +0,0 @@
${guarded
  .trimEnd()
  .split("\n")
  .map((line) => `-${line}`)
  .join("\n")}
`,
    ],
  ])(
    "STALE when the patch %s a whole file",
    async (_verb, patch) => {
      const subject = planted();
      write(subject.root, subject.fault.patch, patch);

      const run = await replayed(subject);

      expect(run.result).toEqual({
        kind: "STALE",
        output: `${subject.fault.patch} creates or deletes a whole file, which replay does not place. It plants a fault only inside a file that exists before and after the patch.`,
      });
    },
    60_000,
  );

  test("STALE when the patch holds no hunk", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, "");

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: `${subject.fault.patch} holds no hunk to apply.`,
    });
  }, 60_000);

  test("refuses a fault whose patch file is missing, naming the file, before it adds a worktree", async () => {
    const subject = planted();
    const patch = "tests/planted-faults/patches/gone.patch";

    const run = isolated(() =>
      replay(
        subject.root,
        { ...subject.fault, patch },
        headOf(subject.root),
        limit,
      ),
    );

    expect(await rejection(run)).toBe(
      `${patch} does not exist, so ${subject.id} has no planted fault to apply. Repair: plant the fault again by hand, run git diff -- <each file you edited> > '${patch}', then undo the planted edit. Done when bun run fault-replay ${subject.id} passes.`,
    );
    expect(worktrees(subject.root)).toEqual([subject.root]);
  }, 60_000);

  test("BROKEN when the named test already fails without the fault", async () => {
    const subject = planted({
      tests: `${limitTests}${redTest}`,
      title: "^L\\.red ",
    });

    const run = await replayed(subject);

    expect(run.result.kind).toBe("BROKEN");
    expect(outputOf(run.result)).toContain("(fail) L.red is red without");
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("BROKEN when the test file fails to load before the fault", async () => {
    const subject = planted({ tests: "throw new Error('does not load');\n" });

    const run = await replayed(subject);

    expect(run.result.kind).toBe("BROKEN");
    expect(outputOf(run.result)).toContain("does not load");
  }, 60_000);

  test("runs only the test file the record names", async () => {
    const subject = planted({
      elsewhere: `import { test } from "bun:test";

test("L.refuses elsewhere", () => {
  throw new Error("a test in another file");
});
`,
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("refuses to give a verdict when the test run dies by a signal", async () => {
    const subject = planted({
      tests: `import { test } from "bun:test";

test("L.refuses dies", () => {
  process.kill(process.pid, "SIGKILL");
});
`,
    });

    const run = isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), limit),
    );

    expect(await rejection(run)).toBe(
      `${process.execPath} test ./tests/limit.test.ts -t ^L\\.refuses  was killed by SIGKILL while replaying ${subject.id}, so it has no verdict.`,
    );
  }, 60_000);

  test("TIMEOUT names a step of the replay as the one that outran the limit, and cleans up", async () => {
    const subject = planted();

    const run = await isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), 1),
    );

    expect(run.result.kind).toBe("TIMEOUT");
    const step = String(Reflect.get(run.result, "step"));
    const bun = process.execPath;
    expect(
      [
        "git worktree add --detach --quiet ",
        "git ls-files ",
        `${bun} install --frozen-lockfile`,
        `${bun} test ./tests/`,
      ].some((start) => step.startsWith(start)),
    ).toBe(true);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("refuses a commit git cannot check out, naming git's words", async () => {
    const subject = planted();

    const run = isolated(() =>
      replay(subject.root, subject.fault, "0".repeat(40), limit),
    );

    expect(await rejection(run)).toContain("invalid reference");
  }, 60_000);

  test("refuses when the install fails, naming the fault and the output", async () => {
    const subject = planted({ manifest: "{ not json" });

    const run = isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), limit),
    );

    expect(await rejection(run)).toStartWith(
      `bun install --frozen-lockfile failed while replaying ${subject.id}:\n`,
    );
  }, 60_000);

  test("replays the commit it is given, not the working tree", async () => {
    const subject = planted();
    write(subject.root, "src/limit.ts", unguarded);

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(readFileSync(join(subject.root, "src/limit.ts"), "utf8")).toBe(
      unguarded,
    );
  }, 60_000);
});

describe("replayAll", () => {
  const environment = { [stepVariable]: "120" };

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

  test("exits 0 and says so when every fault is KILLED", async () => {
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
  }, 60_000);

  test("replays every record in order and exits 1 when one survives", async () => {
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
  }, 60_000);

  test("replays only the records its ids name", async () => {
    const { root, id } = killedAndSurvivor();

    const run = await replayedAll(root, [id]);

    expect(run.result).toBe(0);
    expect(run.stdout).not.toContain("SURVIVED");
    expect(run.stdout).toContain("1 of 1 planted faults KILLED in ");
  }, 60_000);

  test("refuses an unknown id before replaying anything", async () => {
    const { root, id } = killedAndSurvivor();

    const run = await replayedAll(root, [id, "nope", "gone"]);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `No fault record nope, gone in ${recordsPath}. Repair: pass an id that file lists.\n`,
    );
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("reports an unknown id before it reads the step limit", async () => {
    const { root } = killedAndSurvivor();

    const run = await replayedAll(root, ["nope"], { [stepVariable]: "x" });

    expect(run.result).toBe(2);
    expect(run.stderr).toContain("No fault record nope in ");
  }, 60_000);

  test.each([
    ["no records file", null],
    ["an empty records list", "[]"],
  ])(
    "exits 1 and says it checks nothing with %s",
    async (_name, content) => {
      const root = repository("planted-faults-empty-");
      commit(root, "base", { "package.json": "{}" });
      if (content !== null) write(root, recordsPath, content);

      const run = await replayedAll(root);

      expect(run.result).toBe(1);
      expect(run.stdout).toBe(
        `${recordsPath} has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.\n`,
      );
      expect(run.stderr).toBe("");
    },
    60_000,
  );

  test("refuses a step limit that is not a positive number", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);

    const run = replayedAll(subject.root, [], { [stepVariable]: "-3" });

    expect(await rejection(run)).toBe(
      `${stepVariable} is '-3'. Repair: set it to a positive number of seconds, or unset it for 300 s.`,
    );
  }, 60_000);

  test("reports TIMEOUT with the limit in seconds and exits 1", async () => {
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
  }, 60_000);

  test("replays uncommitted and untracked work, leaving the tree as it was", async () => {
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
    write(root, fault.patch, git(root, "diff", "-R", "--", "src/limit.ts"));
    write(root, "tests/limit.test.ts", limitTests);
    write(root, recordsPath, `${JSON.stringify([fault], null, 2)}\n`);
    const head = headOf(root);
    const status = git(root, "status", "--porcelain");

    const run = await replayedAll(root);

    expect(run.result).toBe(0);
    expect(run.stdout).toContain(`KILLED ${fault.id} in `);
    expect(headOf(root)).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(guarded);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays a clean tree at its own head", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);
    const head = headOf(subject.root);
    const objects = git(subject.root, "count-objects");

    const run = await replayedAll(subject.root);

    expect(run.result).toBe(0);
    expect(headOf(subject.root)).toBe(head);
    expect(git(subject.root, "status", "--porcelain")).toBe("");
    expect(git(subject.root, "count-objects")).toBe(objects);
  }, 60_000);
});
