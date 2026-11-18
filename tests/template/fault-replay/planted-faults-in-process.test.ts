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
  createPlantedFaultFixture,
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
} from "../../support/planted-fault-in-process-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { gitOutput, commit, worktrees } from "../../support/git-fixture.ts";

const { isolated, planted, repository } = createPlantedFaultFixture();

const killedBy = ["L.refuses NaN", "L.refuses NaN twice"];

const redTest = `test("L.red is red without the fault", () => {
  expect(limit(1)).toBe(2);
});
`;

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

  test("STALE when the patch no longer applies, with git's own words", async () => {
    const subject = planted();
    write(
      subject.root,
      subject.fault.patch,
      subject.patch.replace("return value;", "return other;"),
    );

    const run = await replayed(subject);

    expect(run.result.kind).toBe("STALE");
    expect(outputOf(run.result)).toContain("patch does not apply");
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
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
        "git apply ",
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
    write(
      root,
      fault.patch,
      gitOutput(root, "diff", "-R", "--", "src/limit.ts"),
    );
    write(root, "tests/limit.test.ts", limitTests);
    write(root, recordsPath, `${JSON.stringify([fault], null, 2)}\n`);
    const head = headOf(root);
    const status = gitOutput(root, "status", "--porcelain");

    const run = await replayedAll(root);

    expect(run.result).toBe(0);
    expect(run.stdout).toContain(`KILLED ${fault.id} in `);
    expect(headOf(root)).toBe(head);
    expect(gitOutput(root, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(guarded);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays a clean tree at its own head", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);
    const head = headOf(subject.root);
    const objects = gitOutput(subject.root, "count-objects");

    const run = await replayedAll(subject.root);

    expect(run.result).toBe(0);
    expect(headOf(subject.root)).toBe(head);
    expect(gitOutput(subject.root, "status", "--porcelain")).toBe("");
    expect(gitOutput(subject.root, "count-objects")).toBe(objects);
  }, 60_000);
});
