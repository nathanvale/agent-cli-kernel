import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  processWatchdog,
  type SignalAt,
  spawnBounded,
} from "./support/process.ts";
import { testFolder } from "./support/test-folder.ts";

const repository = join(import.meta.dir, "..");
const sources = [
  "scripts/check-commits.ts",
  "scripts/child-env.ts",
  "scripts/doctor.ts",
  "scripts/repository.ts",
  "src/toolchain-resolution.ts",
  "repository.json",
];
const folders: string[] = [];
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
// Platform: A git hook runs the suite with these set, and they would point the
// fixture's git at the caller's repository.
const gitLocation = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
]);
const { scripts: production } = (await Bun.file(
  join(repository, "package.json"),
).json()) as { scripts: Record<string, string> };
const lockfileListingADroppedDependency = JSON.stringify({
  lockfileVersion: 1,
  workspaces: { "": { dependencies: { dep: "file:./dep" } } },
  packages: { dep: ["dep@file:dep", {}] },
});
const markers = {
  typecheck: "test ! -e type-error",
  lint: "test ! -e lint-error",
};

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

function inherited(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !gitLocation.has(name)),
  );
}

function folder(prefix: string): string {
  const path = testFolder(prefix);
  folders.push(path);
  return path;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...inherited(), ...gitEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function manifest(pin: string, scripts: Record<string, string>): string {
  return JSON.stringify({
    packageManager: `bun@${pin}`,
    scripts: {
      "check:commits": production["check:commits"],
      doctor: production.doctor,
      ...scripts,
    },
  });
}

function repositoryAt({ pin = Bun.version, scripts = markers } = {}) {
  const root = join(folder("check-commits-repo-"), "repo");
  for (const path of sources) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  git(root, "init", "--quiet", "--initial-branch=main");
  const commit = (subject: string, changes: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(changes))
      if (content === null) git(root, "rm", "--quiet", "--", path);
      else {
        writeFileSync(join(root, path), content);
        git(root, "add", "--", path);
      }
    git(root, "commit", "--quiet", "--allow-empty", "-m", subject);
    return {
      sha: git(root, "rev-parse", "HEAD"),
      short: git(root, "rev-parse", "--short", "HEAD"),
    };
  };
  const base = commit("base", {
    ".gitignore": "node_modules\n",
    "package.json": manifest(pin, scripts),
  });
  return { root, base, commit };
}

async function checkCommits(
  root: string,
  args: string[],
  env: Record<string, string> = {},
  {
    signalAt,
    ownGroup = false,
  }: { signalAt?: SignalAt; ownGroup?: boolean } = {},
) {
  const temporary = folder("check-commits-tmp-");
  const entry = [process.execPath, "run", "check:commits", ...args];
  const run = await spawnBounded(
    ownGroup
      ? ["perl", "-e", "setpgrp(0, 0); exec @ARGV or die", ...entry]
      : entry,
    {
      cwd: root,
      env: { ...inherited(), ...gitEnv, TMPDIR: temporary, ...env },
      ...(signalAt === undefined ? {} : { signalAt }),
    },
  );
  return { ...run, temporary, lines: run.stdout.split("\n") };
}

function worktrees(root: string): string[] {
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
}

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

function verdicts(lines: readonly string[]): string[] {
  return lines.filter((line) => /^(GREEN|RED) /.test(line));
}

function wrongBunRefusals(lines: readonly string[]): string[] {
  return lines.filter((line) =>
    line.startsWith(
      `FAIL bun: found Bun ${Bun.version}, pinned 0.0.1. Repair: `,
    ),
  );
}

function rerunOf(lines: readonly string[]): string {
  const line = lines.find((each) => each.startsWith("Rerun locally: "));
  if (line === undefined) throw new Error("No Rerun locally line.");
  return line.slice("Rerun locally: ".length);
}

function linkedCheckout(root: string): string {
  const caller = join(dirname(root), "caller");
  git(root, "worktree", "add", "--quiet", "--detach", caller);
  for (const path of sources) {
    mkdirSync(dirname(join(caller, path)), { recursive: true });
    copyFileSync(join(root, path), join(caller, path));
  }
  symlinkSync(join(repository, "node_modules"), join(caller, "node_modules"));
  return caller;
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

async function paste(root: string, command: string) {
  const run = await spawnBounded(["sh", "-c", command], {
    cwd: root,
    env: { ...inherited(), ...gitEnv },
  });
  const output = run.stdout + run.stderr;
  return { exit: run.exit, output, lines: output.split("\n") };
}

describe("check:commits", () => {
  test(
    "a red commit is named with the command that failed, and its rerun fails at the same command",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      const pasted = await paste(root, rerunOf(run.lines));

      for (const lines of [run.lines, pasted.lines]) {
        expect(lines).toContain(`RED ${red.short} add a lint error`);
        expect(lines).toContain("Failed: bun run lint");
      }
      expect(run.exit).toBe(1);
      expect(pasted.exit).toBe(1);
    },
    processWatchdog(2),
  );

  test(
    "a commit that fails the real TypeScript compiler stays red after a later fix",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: {
          ...markers,
          typecheck: `"${join(repository, "node_modules/.bin/tsc")}" --noEmit typed.ts`,
        },
      });
      const green = commit("type a number", {
        "typed.ts": "export const count: number = 1;\n",
      });
      const red = commit("assign a string to the number", {
        "typed.ts": 'export const count: number = "one";\n',
      });
      const fix = commit("assign a number again", {
        "typed.ts": "export const count: number = 2;\n",
      });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(`GREEN ${green.short} type a number`);
      expect(run.lines).toContain(
        `RED ${red.short} assign a string to the number`,
      );
      expect(run.lines).toContain("Failed: bun run typecheck");
      expect(run.lines).toContain(
        "typed.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      );
      expect(run.lines).toContain(`GREEN ${fix.short} assign a number again`);
      expect(
        run.lines.filter((line) => line.startsWith("1 of 3 commits are red")),
      ).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "the rerun checks out the red commit, not the head that fixed it",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a type error", { "type-error": "" });
      const fix = commit("remove the type error", { "type-error": null });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      const pasted = await paste(root, rerunOf(run.lines));

      expect(run.lines).toContain(`GREEN ${fix.short} remove the type error`);
      expect(pasted.exit).toBe(1);
      expect(verdicts(pasted.lines)).toEqual([
        `RED ${red.short} add a type error`,
      ]);
    },
    processWatchdog(2),
  );

  test(
    "a commit whose lockfile does not match its manifest is red at bun install --frozen-lockfile",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("keep a lockfile for a removed dependency", {
        "bun.lock": lockfileListingADroppedDependency,
      });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `RED ${red.short} keep a lockfile for a removed dependency`,
      );
      expect(run.lines).toContain("Failed: bun install --frozen-lockfile");
      expect(run.lines).toContain(
        "error: lockfile had changes, but lockfile is frozen",
      );
    },
    processWatchdog(1),
  );

  test(
    "a clean range is reported oldest first and exits 0 with a one-line summary",
    async () => {
      const { root, base, commit } = repositoryAt();
      const first = commit("first green", { "a.txt": "a" });
      const second = commit("second green", { "b.txt": "b" });

      const run = await checkCommits(root, [base.sha, second.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(0);
      expect(verdicts(run.lines)).toEqual([
        `GREEN ${first.short} first green`,
        `GREEN ${second.short} second green`,
      ]);
      expect(
        run.lines.filter((line) =>
          line.startsWith("Checked 2 commits: all green"),
        ),
      ).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "an empty range checks nothing and fails, naming the range",
    async () => {
      const { root, base } = repositoryAt();

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `No commits in ${base.sha}..HEAD to check, so this gate checks nothing. Name a base that HEAD is ahead of.`,
      );
    },
    processWatchdog(1),
  );

  test(
    "a commit that is an ancestor of since is skipped",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("red before since", { "type-error": "" });
      const after = commit("fixed after since", { "type-error": null });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: red.sha,
      });

      expect(run.exit).toBe(0);
      expect(run.lines).toContain(`GREEN ${after.short} fixed after since`);
      expect(run.stdout).not.toContain(red.short);
    },
    processWatchdog(1),
  );

  test(
    "a since commit missing from the clone checks every commit in the range",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("red with no since in the clone", {
        "type-error": "",
      });

      const run = await checkCommits(root, [base.sha]);

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `since f20777f7e67d300ade253060fa2ba36f38c0ca43 is not in this clone, so every commit in ${base.sha}..HEAD is checked.`,
      );
      expect(run.lines).toContain(
        `RED ${red.short} red with no since in the clone`,
      );
    },
    processWatchdog(1),
  );

  test(
    "a merge commit is checked at its own tree, not at a parent",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: { ...markers, lint: "test ! -e left -o ! -e right" },
      });
      git(root, "switch", "--quiet", "--create", "side");
      const left = commit("add left", { left: "" });
      git(root, "switch", "--quiet", "main");
      const right = commit("add right", { right: "" });
      git(root, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
      const merge = git(root, "rev-parse", "--short", "HEAD");

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(`GREEN ${left.short} add left`);
      expect(run.lines).toContain(`GREEN ${right.short} add right`);
      expect(run.lines).toContain(`RED ${merge} merge side`);

      const pasted = await paste(root, rerunOf(run.lines));

      expect(pasted.exit).toBe(1);
      expect(verdicts(pasted.lines)).toEqual([`RED ${merge} merge side`]);
    },
    processWatchdog(2),
  );

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

  test(
    "a commit is judged only with the tools its own tree installs",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: { ...markers, typecheck: "fallow --version" },
      });
      const red = commit("use a tool this commit does not install", {
        "a.txt": "a",
      });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `RED ${red.short} use a tool this commit does not install`,
      );
      expect(run.lines).toContain("Failed: bun run typecheck");
      expect(run.stdout).toContain(
        'error: script "typecheck" exited with code 127',
      );

      const pasted = await paste(root, rerunOf(run.lines));

      expect(pasted.exit).toBe(1);
      expect(verdicts(pasted.lines)).toEqual([
        `RED ${red.short} use a tool this commit does not install`,
      ]);
      expect(pasted.output).toContain(
        'error: script "typecheck" exited with code 127',
      );
    },
    processWatchdog(2),
  );

  test(
    "the printed rerun reproduces the failure when pasted twice from a linked checkout, and leaves no worktree",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });
      const caller = linkedCheckout(root);
      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      const rerun = rerunOf(run.lines);

      const first = await paste(caller, rerun);
      const second = await paste(caller, rerun);

      for (const pasted of [first, second]) {
        expect(pasted.exit).toBe(1);
        expect(verdicts(pasted.lines)).toEqual([
          `RED ${red.short} add a lint error`,
        ]);
        expect(pasted.lines).toContain(
          'error: script "lint" exited with code 1',
        );
      }
      expect(worktrees(root).sort()).toEqual(
        [root, caller].map((path) => `worktree ${realpathSync(path)}`).sort(),
      );
    },
    processWatchdog(3),
  );

  test(
    "the printed rerun refuses a Bun other than the pin before it touches the red commit",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });
      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      writeFileSync(join(root, "package.json"), manifest("0.0.1", markers));

      const pasted = await paste(root, rerunOf(run.lines));

      expect(run.lines).toContain(`RED ${red.short} add a lint error`);
      expect(pasted.exit).toBe(1);
      expect(wrongBunRefusals(pasted.lines)).toHaveLength(1);
      expect(verdicts(pasted.lines)).toEqual([]);
      expect(worktrees(root)).toHaveLength(1);
    },
    processWatchdog(2),
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

  test("the CI commits job runs each commit's steps with no stored git token", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(join(repository, ".github/workflows/ci.yml")).text(),
    ) as {
      jobs: {
        commits: { steps: { uses?: string; with?: Record<string, unknown> }[] };
      };
    };
    const checkout = workflow.jobs.commits.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(checkout?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  test(
    "a caller's git location variables, as a git hook sets them, never reach the fixture",
    async () => {
      const planted = folder("check-commits-planted-");
      const location = {
        GIT_DIR: join(planted, "dir"),
        GIT_INDEX_FILE: join(planted, "index"),
      };
      Object.assign(process.env, location);
      try {
        const { root, base, commit } = repositoryAt();
        const green = commit("green under a hook", { "a.txt": "a" });

        const run = await checkCommits(root, [base.sha], {
          CHECK_COMMITS_SINCE: base.sha,
        });

        expect(run.exit).toBe(0);
        expect(verdicts(run.lines)).toEqual([
          `GREEN ${green.short} green under a hook`,
        ]);
        expect(readdirSync(planted)).toEqual([]);
      } finally {
        for (const name of Object.keys(location)) delete process.env[name];
      }
    },
    processWatchdog(1),
  );

  test(
    "a running Bun other than the pin refuses before checking any commit",
    async () => {
      const { root, base, commit } = repositoryAt({ pin: "0.0.1" });
      commit("never checked", { "a.txt": "a" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(wrongBunRefusals(run.lines)).toHaveLength(1);
      expect(run.lines).toContain(
        "Refused: repair the doctor's FAIL lines, then rerun.",
      );
      expect(verdicts(run.lines)).toEqual([]);
    },
    processWatchdog(1),
  );
});
