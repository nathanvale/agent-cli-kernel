import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  checkCommitsFixture,
  linkedCheckout,
  markers,
  verdicts,
  worktrees,
} from "./support/check-commits-fixture.ts";
import { git } from "./support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "./support/process.ts";

const { folder, repositoryAt, checkCommits } = checkCommitsFixture();

function blockThenFailPlainlyOnSignal(ledger: string): string {
  return `test ! -e block || { trap 'kill $!; exit 3' HUP INT TERM; echo started >> '${ledger}'; sleep 30 & wait; }`;
}

function blockWithABackgroundSleep(
  ledger: string,
  pids: string,
  ignoreTerm: boolean,
): string {
  return `test ! -e block || { ${ignoreTerm ? "trap '' TERM; " : ""}sleep 30 & echo $! > '${pids}'; echo started >> '${ledger}'; wait; }`;
}

async function survivingSleep(pids: string): Promise<number | undefined> {
  if (!existsSync(pids)) return undefined;
  const pid = readFileSync(pids, "utf8").trim();
  const shown = await spawnBounded(["ps", "-o", "stat=,command=", "-p", pid]);
  const [stat = "", ...command] = shown.stdout.trim().split(/\s+/);
  return shown.exit === 0 &&
    !stat.startsWith("Z") &&
    command.join(" ") === "sleep 30"
    ? Number(pid)
    : undefined;
}

function executable(path: string, script: string): string {
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

function signalOwnGroupAtCheckoutOf(root: string, signal: string): void {
  executable(
    join(root, ".git", "hooks", "post-checkout"),
    `test ! -e block || kill -s ${signal.slice(3)} 0`,
  );
}

function atRemovalOfABlock(script: string): Record<string, string> {
  const bin = folder("check-commits-bin-");
  executable(
    join(bin, "git"),
    `if [ "$1 $2" = "worktree remove" ] && [ -e "$4/block" ]; then ${script}; fi
exec '${Bun.which("git")}' "$@"`,
  );
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

describe("check:commits", () => {
  test(
    "no temporary worktree remains after a red run",
    async () => {
      const { root, base, commit } = repositoryAt();
      commit("add a type error", { "type-error": "" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(worktrees(root)).toHaveLength(1);
      expect(readdirSync(run.temporary)).toEqual([]);
    },
    processWatchdog(1),
  );

  for (const [signal, exit] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    test(
      `${signal} leaves no worktree and no verdict for the interrupted commit`,
      async () => {
        const ledger = join(folder("check-commits-ledger-"), "ledger");
        const { root, base, commit } = repositoryAt({
          scripts: {
            ...markers,
            typecheck: blockThenFailPlainlyOnSignal(ledger),
          },
        });
        const before = commit("green before the stop", { "a.txt": "a" });
        const stopped = commit("block until stopped", { block: "" });

        const run = await checkCommits(
          root,
          [base.sha],
          { CHECK_COMMITS_SINCE: base.sha },
          { signalAt: { ledger, line: "started", signal } },
        );

        expect(run.exit).toBe(exit);
        expect(verdicts(run.lines)).toEqual([
          `GREEN ${before.short} green before the stop`,
        ]);
        expect(run.stderr.split("\n")).toContain(
          `Stopped by ${signal} while checking ${stopped.short}, so it has no verdict.`,
        );
        expect(worktrees(root)).toHaveLength(1);
        expect(readdirSync(run.temporary)).toEqual([]);
      },
      processWatchdog(1),
    );

  for (const [name, ignoreTerm] of [
    ["a background grandchild", false],
    ["a step that ignores SIGTERM", true],
  ] as const)
    test(
      `SIGTERM stops ${name}, leaves no process and no worktree, and exits 143`,
      async () => {
        const scratch = folder("check-commits-ledger-");
        const ledger = join(scratch, "ledger");
        const pids = join(scratch, "pids");
        try {
          const { root, base, commit } = repositoryAt({
            scripts: {
              ...markers,
              typecheck: blockWithABackgroundSleep(ledger, pids, ignoreTerm),
            },
          });
          const stopped = commit("block until stopped", { block: "" });

          const run = await checkCommits(
            root,
            [base.sha],
            { CHECK_COMMITS_SINCE: base.sha },
            { signalAt: { ledger, line: "started", signal: "SIGTERM" } },
          );

          expect(run.exit).toBe(143);
          expect(verdicts(run.lines)).toEqual([]);
          expect(run.stderr.split("\n")).toContain(
            `Stopped by SIGTERM while checking ${stopped.short}, so it has no verdict.`,
          );
          expect(await survivingSleep(pids)).toBeUndefined();
          expect(worktrees(root)).toHaveLength(1);
          expect(readdirSync(run.temporary)).toEqual([]);
        } finally {
          const left = await survivingSleep(pids);
          if (left !== undefined) process.kill(left, "SIGKILL");
        }
      },
      processWatchdog(3),
    );

  for (const [signal, exit] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    test(
      `${signal} to the whole process group while git adds the worktree is the stop, not a git failure`,
      async () => {
        const { root, base, commit } = repositoryAt();
        const before = commit("green before the stop", { "a.txt": "a" });
        const stopped = commit("stop while checking out", { block: "" });
        signalOwnGroupAtCheckoutOf(root, signal);

        const run = await checkCommits(
          root,
          [base.sha],
          { CHECK_COMMITS_SINCE: base.sha },
          { ownGroup: true },
        );

        expect(run.exit).toBe(exit);
        expect(verdicts(run.lines)).toEqual([
          `GREEN ${before.short} green before the stop`,
        ]);
        expect(run.stderr.split("\n")).toContain(
          `Stopped by ${signal} while checking ${stopped.short}, so it has no verdict.`,
        );
        expect(worktrees(root)).toHaveLength(1);
        expect(readdirSync(run.temporary)).toEqual([]);
      },
      processWatchdog(1),
    );

  test(
    "SIGTERM to the whole process group while git removes the worktree leaves no registered worktree and no verdict",
    async () => {
      const { root, base, commit } = repositoryAt();
      const before = commit("green before the stop", { "a.txt": "a" });
      const stopped = commit("stop while removing", { block: "" });

      const run = await checkCommits(
        root,
        [base.sha],
        {
          CHECK_COMMITS_SINCE: base.sha,
          ...atRemovalOfABlock("kill -s TERM 0"),
        },
        { ownGroup: true },
      );

      expect(run.exit).toBe(143);
      expect(verdicts(run.lines)).toEqual([
        `GREEN ${before.short} green before the stop`,
      ]);
      expect(run.stderr.split("\n")).toContain(
        `Stopped by SIGTERM while checking ${stopped.short}, so it has no verdict.`,
      );
      expect(worktrees(root)).toHaveLength(1);
      expect(readdirSync(run.temporary)).toEqual([]);
    },
    processWatchdog(1),
  );

  test(
    "a failed removal from a linked checkout deletes only the script's own registration",
    async () => {
      const { root, base, commit } = repositoryAt();
      const extra = join(dirname(root), "extra");
      git(root, "worktree", "add", "--quiet", "--detach", extra);
      const blocked = commit("fail the removal", { block: "" });
      const caller = linkedCheckout(root);

      const run = await checkCommits(caller, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
        ...atRemovalOfABlock("exit 1"),
      });

      expect(run.exit).toBe(0);
      expect(verdicts(run.lines)).toEqual([
        `GREEN ${blocked.short} fail the removal`,
      ]);
      expect(worktrees(root).sort()).toEqual(
        [root, caller, extra]
          .map((path) => `worktree ${realpathSync(path)}`)
          .sort(),
      );
      expect(readdirSync(run.temporary)).toEqual([]);
    },
    processWatchdog(1),
  );

  test(
    "a failed removal never deletes the sibling registration a rewritten .git file points to",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: {
          ...markers,
          typecheck:
            'test ! -e block || echo "gitdir: $(git rev-parse --path-format=absolute --git-common-dir)/worktrees/extra" > .git',
        },
      });
      const extra = join(dirname(root), "extra");
      git(root, "worktree", "add", "--quiet", "--detach", extra);
      const blocked = commit("point .git at a sibling registration", {
        block: "",
      });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
        ...atRemovalOfABlock("exit 1"),
      });

      expect(run.exit).toBe(0);
      expect(verdicts(run.lines)).toEqual([
        `GREEN ${blocked.short} point .git at a sibling registration`,
      ]);
      expect(worktrees(root).sort()).toEqual(
        [root, extra].map((path) => `worktree ${realpathSync(path)}`).sort(),
      );
      expect(run.stderr).not.toContain("git worktree remove failed");
      expect(readdirSync(run.temporary)).toEqual([]);
    },
    processWatchdog(1),
  );

  test(
    "a failed removal keeps an admin folder that no longer names the worktree, and names the repair",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: {
          ...markers,
          typecheck:
            'test ! -e block || echo /elsewhere/.git > "$(git rev-parse --git-dir)/gitdir"',
        },
      });
      const blocked = commit("repoint the admin folder", { block: "" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
        ...atRemovalOfABlock("exit 1"),
      });

      expect(run.exit).toBe(0);
      expect(verdicts(run.lines)).toEqual([
        `GREEN ${blocked.short} repoint the admin folder`,
      ]);
      expect(
        run.stderr
          .split("\n")
          .filter(
            (line) =>
              line.startsWith("git worktree remove failed for ") &&
              line.endsWith(
                "no longer names it, so that registration stays. Repair: git worktree prune",
              ),
          ),
      ).toHaveLength(1);
      expect(readdirSync(run.temporary)).toEqual([]);
    },
    processWatchdog(1),
  );

  test(
    "a step killed by a signal the run did not receive gives no verdict and exits 2",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: {
          ...markers,
          typecheck: "test ! -e kill || kill -KILL $PPID",
        },
      });
      const killed = commit("kill the typecheck step", { kill: "" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(2);
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.stderr.split("\n")).toContain(
        `bun run typecheck was killed by SIGKILL while checking ${killed.short}, so it has no verdict.`,
      );
      expect(worktrees(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );
});
