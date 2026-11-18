import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, main } from "../../../scripts/check-commits.ts";
import {
  absentFixedPoint,
  captured,
  createCommitCheckFixture,
  ledgered,
  ledgerScript,
  refusal,
  registered,
} from "../../support/check-commits-in-process-fixture.ts";
import { processWatchdog, watchLedger } from "../../support/process.ts";

const { folder, repositoryAt, inTemporaryFolder } = createCommitCheckFixture();

describe("main", () => {
  test("no base is refused with the usage line and exit code 2", async () => {
    const { run } = repositoryAt();

    const shown = await captured(() => main([], run));

    expect(shown.value).toBe(2);
    expect(shown.stderr).toBe("Usage: bun run check:commits <base> [head]\n");
    expect(shown.lines).toEqual([""]);
  });

  test(
    "a Bun other than the pin is refused after the doctor names it, with exit code 1 and no commit checked",
    async () => {
      const { base, commit, run } = repositoryAt({ pin: "0.0.1" });
      commit("a commit that is never checked", { "a.txt": "a" });

      const shown = await captured(() => main([base.sha], run));

      expect(shown.value).toBe(1);
      expect(
        shown.lines.filter((line) =>
          line.startsWith(
            `FAIL bun: found Bun ${Bun.version}, pinned 0.0.1. Repair: `,
          ),
        ),
      ).toHaveLength(1);
      expect(shown.lines).toContain(
        "Refused: repair the doctor's FAIL lines, then rerun.",
      );
      expect(shown.lines.filter((line) => /^(GREEN|RED) /.test(line))).toEqual(
        [],
      );
    },
    processWatchdog(1),
  );

  test(
    "an empty range checks nothing and fails, naming the range",
    async () => {
      const { base, run } = repositoryAt();

      const shown = await captured(() => main([base.sha], run));

      expect(shown.value).toBe(1);
      expect(shown.lines).toContain(
        `No commits in ${base.sha}..HEAD to check, so this gate checks nothing. Repair: name a base that HEAD is ahead of.`,
      );
      expect(shown.lines.some((line) => line.startsWith("Checked "))).toBe(
        false,
      );
    },
    processWatchdog(1),
  );

  test(
    "a clean range up to the named head is reported oldest first with a one-line summary and exit code 0",
    async () => {
      const { root, base, commit, run } = repositoryAt();
      const first = commit("first green", { "a.txt": "a" });
      const second = commit("second green", { "b.txt": "b" });
      const beyond = commit("beyond the head", { "c.txt": "c" });

      const started = performance.now();
      const shown = await inTemporaryFolder(async (temporary) => {
        const result = await captured(() => main([base.sha, second.sha], run));
        expect(readdirSync(temporary)).toEqual([]);
        return result;
      });
      const wall = (performance.now() - started) / 1000;

      expect(shown.value).toBe(0);
      expect(shown.lines.filter((line) => /^(GREEN|RED) /.test(line))).toEqual([
        `GREEN ${first.short} first green`,
        `GREEN ${second.short} second green`,
      ]);
      expect(shown.lines.join("\n")).not.toContain(beyond.short);
      const pace = shown.lines
        .map((line) =>
          /^Checked 2 commits: all green in (\d+\.\d) s, (\d+\.\d) s per commit\.$/.exec(
            line,
          ),
        )
        .filter((found) => found !== null);
      expect(pace).toHaveLength(1);
      const [, seconds = "", each = ""] = pace[0] ?? [];
      expect(Number(seconds)).toBeGreaterThanOrEqual(0);
      expect(Number(seconds)).toBeLessThanOrEqual(wall + 0.05);
      expect(Math.abs(Number(each) * 2 - Number(seconds))).toBeLessThanOrEqual(
        0.16,
      );
      expect(
        shown.lines.filter((line) =>
          line.endsWith(
            ` is not in this clone, so every commit in ${base.sha}..${second.sha} is checked.`,
          ),
        ),
      ).toHaveLength(1);
      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(2),
  );

  test(
    "a red commit is named with its failed step, its repair and its rerun, the range still finishes, and the exit code is 1",
    async () => {
      const { root, base, commit, run } = repositoryAt();
      const first = commit("first green", { "a.txt": "a" });
      const red = commit("add a type error", { "type-error": "" });
      const fix = commit("remove the type error", { "type-error": null });

      const shown = await captured(() => main([base.sha], run));

      expect(shown.value).toBe(1);
      expect(shown.lines.filter((line) => /^(GREEN|RED) /.test(line))).toEqual([
        `GREEN ${first.short} first green`,
        `RED ${red.short} add a type error`,
        `GREEN ${fix.short} remove the type error`,
      ]);
      expect(shown.lines).toContain("Failed: bun run typecheck");
      expect(shown.lines).toContain(
        `Repair: change ${red.short} itself so that bun run typecheck passes at that commit.`,
      );
      expect(shown.lines).toContain(
        `Rerun locally: CHECK_COMMITS_SINCE='${absentFixedPoint}' bun run check:commits '${red.sha}^@' ${red.sha}`,
      );
      expect(shown.lines).toContain(
        'error: script "typecheck" exited with code 1',
      );
      expect(
        shown.lines.filter((line) =>
          /^1 of 3 commits are red in \d+\.\d s, \d+\.\d s per commit\.$/.test(
            line,
          ),
        ),
      ).toHaveLength(1);
      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(3),
  );

  test(
    "a since commit in the clone is excluded with its ancestors, and the printed rerun names it",
    async () => {
      const { base, commit, run } = repositoryAt();
      const since = commit("the since commit", { "a.txt": "a" });
      const red = commit("add a type error", { "type-error": "" });
      const fix = commit("remove the type error", { "type-error": null });

      const shown = await captured(() =>
        main([base.sha], { ...run, fixedPoint: since.sha }),
      );

      expect(shown.value).toBe(1);
      expect(shown.lines.filter((line) => /^(GREEN|RED) /.test(line))).toEqual([
        `RED ${red.short} add a type error`,
        `GREEN ${fix.short} remove the type error`,
      ]);
      expect(shown.lines).toContain(
        `Rerun locally: CHECK_COMMITS_SINCE='${since.sha}' bun run check:commits '${red.sha}^@' ${red.sha}`,
      );
      expect(shown.lines.some((line) => line.startsWith("since "))).toBe(false);
      expect(shown.lines).toContain("$ test ! -e type-error");
      expect(shown.lines).toContain(
        'error: script "typecheck" exited with code 1',
      );
      expect(shown.lines.slice(0, -1)).not.toContain("");
    },
    processWatchdog(2),
  );

  test(
    "a head git does not know is refused with git's own message and nothing is checked",
    async () => {
      const { base, run } = repositoryAt();

      const shown = await captured(() =>
        refusal(main([base.sha, "no-such-head"], run)),
      );

      expect(shown.value).toBe(
        "fatal: ambiguous argument 'no-such-head': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'",
      );
      expect(shown.lines.filter((line) => /^(GREEN|RED) /.test(line))).toEqual(
        [],
      );
    },
    processWatchdog(1),
  );
});

describe("after a stop signal", () => {
  test(
    "check gives no verdict for the commit it was checking, naming the signal, and leaves no worktree behind",
    async () => {
      const { root, commit, run } = repositoryAt();
      const stopped = commit("stop while the worktree is added", {
        "a.txt": "a",
      });
      writeFileSync(
        join(root, ".git", "hooks", "post-checkout"),
        "#!/bin/sh\nkill -s TERM $PPID\n",
        { mode: 0o755 },
      );

      await inTemporaryFolder(async (temporary) => {
        expect(await refusal(check(run, stopped))).toBe(
          `Stopped by SIGTERM while checking ${stopped.short}, so it has no verdict.`,
        );
        expect(readdirSync(temporary)).toEqual([]);
      });

      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "check gives no verdict when the stop arrives while a step runs, ends that step, and leaves no worktree behind",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const { root, run, active, commit } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(ledger, "typecheck", "sleep 30"),
          lint: ledgerScript(ledger, "lint", "true"),
        },
      });
      const stopped = commit("stop while typecheck runs", { "a.txt": "a" });
      const watch = watchLedger(ledger, "typecheck", 15_000);
      watch.reached.then(
        () => {
          active.stoppedBy ??= "SIGINT";
          active.stop?.();
        },
        () => {},
      );

      try {
        await inTemporaryFolder(async (temporary) => {
          expect(await refusal(check(run, stopped))).toBe(
            `Stopped by SIGINT while checking ${stopped.short}, so it has no verdict.`,
          );
          expect(readdirSync(temporary)).toEqual([]);
        });
      } finally {
        watch.stop();
      }

      expect(ledgered(ledger)).toEqual(["typecheck"]);
      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );
});
