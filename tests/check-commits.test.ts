import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnBounded } from "./contract3/kernel-repair/swarm-process.ts";

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
) {
  const temporary = folder("check-commits-tmp-");
  const run = await spawnBounded(
    [process.execPath, "run", "check:commits", ...args],
    {
      cwd: root,
      env: { ...process.env, ...gitEnv, TMPDIR: temporary, ...env },
      boundMilliseconds: bound,
    },
  );
  return { ...run, temporary, lines: run.stdout.split("\n") };
}

describe("check:commits", () => {
  test(
    "a red commit is named with the command that failed, and the run exits 1",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(`RED ${red.short} add a lint error`);
      expect(run.lines).toContain("Failed: bun run lint");
      const rerun = run.lines.find((line) => line.startsWith("Rerun locally:"));
      expect(rerun).toContain(red.sha);
      expect(rerun).toEndWith("bun run lint");
    },
    timeout,
  );

  test(
    "a later fix commit does not hide the earlier red commit",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a type error", { "type-error": "" });
      const fix = commit("remove the type error", { "type-error": null });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(`RED ${red.short} add a type error`);
      expect(run.lines).toContain("Failed: bun run typecheck");
      expect(run.lines).toContain(`GREEN ${fix.short} remove the type error`);
      expect(
        run.lines.filter((line) => line.startsWith("1 of 2 commits are red")),
      ).toHaveLength(1);
    },
    timeout,
  );

  test(
    "a clean range exits 0 with a one-line summary",
    async () => {
      const { root, base, commit } = repositoryAt();
      const first = commit("first green", { "a.txt": "a" });
      const second = commit("second green", { "b.txt": "b" });

      const run = await checkCommits(root, [base.sha, second.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(0);
      expect(run.lines).toContain(`GREEN ${first.short} first green`);
      expect(run.lines).toContain(`GREEN ${second.short} second green`);
      expect(run.lines.some((line) => line.startsWith("RED "))).toBe(false);
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
    "a merge commit in the range is checked and named",
    async () => {
      const { root, base, commit } = repositoryAt();
      git(root, "switch", "--quiet", "--create", "side");
      commit("side green", { "side.txt": "side" });
      git(root, "switch", "--quiet", "main");
      commit("main green", { "main.txt": "main" });
      git(root, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
      const merge = git(root, "rev-parse", "--short", "HEAD");

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(0);
      expect(run.lines).toContain(`GREEN ${merge} merge side`);
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
      expect(
        git(root, "worktree", "list", "--porcelain")
          .split("\n")
          .filter((line) => line.startsWith("worktree ")),
      ).toHaveLength(1);
      expect(readdirSync(run.temporary)).toEqual([]);
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
      expect(run.lines.some((line) => /^(GREEN|RED) /.test(line))).toBe(false);
    },
    timeout,
  );
});
