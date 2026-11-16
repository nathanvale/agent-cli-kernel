import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type SignalAt,
  spawnBounded,
} from "./contract3/kernel-repair/swarm-process.ts";

const repository = join(import.meta.dir, "..");
const sources = [
  "scripts/check-commits.ts",
  "scripts/doctor.ts",
  "src/toolchain-resolution.ts",
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
const bound = 15_000;
const timeout = 20_000;
const { scripts: production } = (await Bun.file(
  join(repository, "package.json"),
).json()) as { scripts: Record<string, string> };
// A lockfile that still lists a dependency its manifest dropped. Only
// `--frozen-lockfile` refuses it, and it needs no network.
const staleLockfile = JSON.stringify({
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

function folder(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  folders.push(path);
  return path;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...process.env, ...gitEnv },
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
  const base = commit("base", { "package.json": manifest(pin, scripts) });
  return { root, base, commit };
}

async function checkCommits(
  root: string,
  args: string[],
  env: Record<string, string> = {},
  signalAt?: SignalAt,
) {
  const temporary = folder("check-commits-tmp-");
  const run = await spawnBounded(
    [process.execPath, "run", "check:commits", ...args],
    {
      cwd: root,
      env: { ...process.env, ...gitEnv, TMPDIR: temporary, ...env },
      boundMilliseconds: bound,
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

// The step writes `started` to the ledger, then waits. On a signal it exits 3,
// a plain failure, so only the stop check keeps the commit from reading RED.
function blockUntilSignalled(ledger: string): string {
  return `test ! -e block || { trap 'kill $!; exit 3' HUP INT TERM; echo started >> '${ledger}'; sleep 30 & wait; }`;
}

function verdicts(lines: readonly string[]): string[] {
  return lines.filter((line) => /^(GREEN|RED) /.test(line));
}

function rerunOf(lines: readonly string[]): string {
  const line = lines.find((each) => each.startsWith("Rerun locally: "));
  if (line === undefined) throw new Error("No Rerun locally line.");
  return line.slice("Rerun locally: ".length);
}

async function paste(root: string, command: string) {
  const run = await spawnBounded(["sh", "-c", command], {
    cwd: root,
    env: { ...process.env, ...gitEnv },
    boundMilliseconds: bound,
  });
  const output = run.stdout + run.stderr;
  return { exit: run.exit, output, lines: output.split("\n") };
}

describe("check:commits", () => {
  test(
    "a red commit is named with the command that failed, and its rerun replays every step up to it",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(`RED ${red.short} add a lint error`);
      expect(run.lines).toContain("Failed: bun run lint");
      expect(rerunOf(run.lines)).toEndWith(
        `&& (cd ../red-${red.short} && bun install --frozen-lockfile && bun run typecheck && bun run lint)`,
      );
    },
    timeout,
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
    timeout,
  );

  test(
    "the rerun checks out the red commit, not the head that fixed it",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a type error", { "type-error": "" });
      commit("remove the type error", { "type-error": null });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(rerunOf(run.lines)).toContain(
        `git worktree add --detach ../red-${red.short} ${red.sha};`,
      );
    },
    timeout,
  );

  test(
    "a commit whose lockfile does not match its manifest is red at bun install --frozen-lockfile",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("keep a lockfile for a removed dependency", {
        "bun.lock": staleLockfile,
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
    timeout,
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
    timeout,
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
    timeout,
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
    timeout,
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
    },
    timeout,
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
    timeout,
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
    },
    timeout,
  );

  test(
    "the printed rerun reproduces the failure when pasted twice",
    async () => {
      const { root, base, commit } = repositoryAt();
      commit("add a lint error", { "lint-error": "" });
      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      const rerun = rerunOf(run.lines);

      const first = await paste(root, rerun);
      const second = await paste(root, rerun);

      for (const pasted of [first, second]) {
        expect(pasted.exit).toBe(1);
        expect(pasted.lines).toContain(
          'error: script "lint" exited with code 1',
        );
      }
    },
    timeout,
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

      expect(pasted.exit).toBe(1);
      expect(pasted.lines).toContain(
        `FAIL bun: found Bun ${Bun.version}, pinned 0.0.1. Repair: install Bun 0.0.1 (mise install bun@0.0.1, or setup-bun in CI), then bun install --frozen-lockfile.`,
      );
      expect(existsSync(join(root, "..", `red-${red.short}`))).toBe(false);
    },
    timeout,
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
          scripts: { ...markers, typecheck: blockUntilSignalled(ledger) },
        });
        const before = commit("green before the stop", { "a.txt": "a" });
        const stopped = commit("block until stopped", { block: "" });

        const run = await checkCommits(
          root,
          [base.sha],
          { CHECK_COMMITS_SINCE: base.sha },
          { ledger, line: "started", signal },
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
      timeout,
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
    timeout,
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
      expect(run.lines).toContain(
        `FAIL bun: found Bun ${Bun.version}, pinned 0.0.1. Repair: install Bun 0.0.1 (mise install bun@0.0.1, or setup-bun in CI), then bun install --frozen-lockfile.`,
      );
      expect(verdicts(run.lines)).toEqual([]);
    },
    timeout,
  );
});
