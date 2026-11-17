import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type Active,
  check,
  main,
  release,
  type Run,
} from "../scripts/check-commits.ts";
import { commitIn, git } from "./support/git-fixture.ts";
import { processWatchdog, watchLedger } from "./support/process.ts";
import { testFolder } from "./support/test-folder.ts";

const repository = join(import.meta.dir, "..");
const folders: string[] = [];
const markers = {
  typecheck: "test ! -e type-error",
  lint: "test ! -e lint-error",
};
const absentFixedPoint = "f".repeat(40);
const lockfileListingADroppedDependency = JSON.stringify({
  lockfileVersion: 1,
  workspaces: { "": { dependencies: { dep: "file:./dep" } } },
  packages: { dep: ["dep@file:dep", {}] },
});

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

function folder(prefix: string): string {
  const path = testFolder(prefix);
  folders.push(path);
  return path;
}

function repositoryAt({
  pin = Bun.version,
  scripts = markers,
}: {
  pin?: string;
  scripts?: Record<string, string>;
} = {}) {
  const root = join(folder("check-commits-process-repo-"), "repo");
  mkdirSync(root);
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  git(root, "init", "--quiet", "--initial-branch=main");
  const commit = (subject: string, changes: Record<string, string | null>) => ({
    ...commitIn(root, subject, changes),
    subject,
  });
  const base = commit("base", {
    ".gitignore": "node_modules\n",
    "package.json": JSON.stringify({ packageManager: `bun@${pin}`, scripts }),
  });
  const active: Active = {};
  const run: Run = { root, fixedPoint: absentFixedPoint, active };
  return { root, run, active, base, commit };
}

async function captured<T>(run: () => T | Promise<T>) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  try {
    const value = await run();
    return { value, lines: out.join("").split("\n"), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

async function refusal(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

async function inTemporaryFolder<T>(run: (temporary: string) => Promise<T>) {
  const temporary = folder("check-commits-process-tmp-");
  const before = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  try {
    return await run(temporary);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
}

function worktreeAt(root: string, name: string) {
  const dir = join(folder("check-commits-process-tree-"), name);
  git(root, "worktree", "add", "--detach", "--quiet", dir, "HEAD");
  const admin = git(dir, "rev-parse", "--path-format=absolute", "--git-dir");
  return { dir: realpathSync(dir), admin };
}

function registered(root: string): string[] {
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
}

function ledgerScript(ledger: string, step: string, test: string): string {
  return `echo ${step} >> '${ledger}'; ${test}`;
}

function ledgered(ledger: string): string[] {
  return existsSync(ledger)
    ? readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    : [];
}

describe("release", () => {
  test("a registered worktree is removed with its administrative folder", () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "plain");

    release(run, dir, admin);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(registered(root)).toEqual([`worktree ${realpathSync(root)}`]);
  });

  test("a worktree git refuses to remove loses the administrative folder that still names it", async () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "locked");
    git(root, "worktree", "lock", dir);

    const shown = await captured(() => release(run, dir, admin));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(registered(root)).toEqual([`worktree ${realpathSync(root)}`]);
    expect(shown.stderr).toBe("");
  });

  test("a worktree git refuses to remove keeps a registration that names another folder, and says how to repair it", async () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "moved");
    git(root, "worktree", "lock", dir);
    writeFileSync(join(admin, "gitdir"), join(dir, "elsewhere", ".git"));

    const shown = await captured(() => release(run, dir, admin));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(true);
    expect(shown.stderr).toBe(
      `git worktree remove failed for ${dir}, and ${admin} no longer names it, so that registration stays. Repair: git worktree prune\n`,
    );
  });

  test("a locked worktree whose administrative folder lost its gitdir file keeps that folder", async () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "headless");
    git(root, "worktree", "lock", dir);
    rmSync(join(admin, "gitdir"));

    const shown = await captured(() => release(run, dir, admin));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(true);
    expect(shown.stderr).toContain("no longer names it");
  });

  test("a folder git does not know is deleted quietly when no administrative folder was found", async () => {
    const { root, run } = repositoryAt();
    const dir = join(folder("check-commits-process-tree-"), "unknown");
    mkdirSync(dir);
    writeFileSync(join(dir, "left-over"), "");

    const shown = await captured(() => release(run, dir, undefined));

    expect(existsSync(dir)).toBe(false);
    expect(shown.stderr).toBe("");
    expect(registered(root)).toHaveLength(1);
  });

  test("a folder git does not know is deleted quietly when its administrative folder is already gone", async () => {
    const { run } = repositoryAt();
    const dir = join(folder("check-commits-process-tree-"), "unknown");
    mkdirSync(dir);

    const shown = await captured(() =>
      release(run, dir, join(dir, "no-such-admin")),
    );

    expect(existsSync(dir)).toBe(false);
    expect(shown.stderr).toBe("");
  });

  test("a worktree git removed itself leaves any folder that was passed as its administrative folder alone", async () => {
    const { root, run } = repositoryAt();
    const { dir } = worktreeAt(root, "removed-by-git");
    const bystander = folder("check-commits-process-bystander-");
    writeFileSync(join(bystander, "gitdir"), join(dir, ".git"));

    const shown = await captured(() => release(run, dir, bystander));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(bystander)).toBe(true);
    expect(shown.stderr).toBe("");
  });
});

describe("check", () => {
  test(
    "a green commit runs typecheck then lint in a worktree under the temporary folder, is judged green, and leaves no worktree behind",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const places = `${ledger}-places`;
      const { root, commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(
            ledger,
            "typecheck",
            `pwd >> '${places}'; true`,
          ),
          lint: ledgerScript(ledger, "lint", `pwd >> '${places}'; true`),
        },
      });
      const green = commit("a green commit", { "a.txt": "a" });

      const { checked, temporary } = await inTemporaryFolder(
        async (temporary) => {
          const result = await check(run, green);
          expect(readdirSync(temporary)).toEqual([]);
          return { checked: result, temporary };
        },
      );

      const [first = "", second] = readFileSync(places, "utf8")
        .split("\n")
        .filter(Boolean);
      expect(checked).toEqual({ ...green, result: { status: "green" } });
      expect(ledgered(ledger)).toEqual(["typecheck", "lint"]);
      expect(dirname(first)).toBe(realpathSync(temporary));
      expect(basename(first).startsWith("check-commits-")).toBe(true);
      expect(second).toBe(first);
      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a failing typecheck is red at that step and lint never runs",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const { root, commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(ledger, "typecheck", "test ! -e type-error"),
          lint: ledgerScript(ledger, "lint", "true"),
        },
      });
      const red = commit("add a type error", { "type-error": "" });

      const checked = await check(run, red);

      expect(checked).toMatchObject({
        ...red,
        result: { status: "red", failed: ["run", "typecheck"] },
      });
      expect(checked.result).toHaveProperty(
        "output",
        expect.stringContaining('error: script "typecheck" exited with code 1'),
      );
      expect(ledgered(ledger)).toEqual(["typecheck"]);
      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a failing lint is red at that step after typecheck passed",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const { commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(ledger, "typecheck", "true"),
          lint: ledgerScript(ledger, "lint", "test ! -e lint-error"),
        },
      });
      const red = commit("add a lint error", { "lint-error": "" });

      const checked = await check(run, red);

      expect(checked).toMatchObject({
        ...red,
        result: { status: "red", failed: ["run", "lint"] },
      });
      expect(checked.result).toHaveProperty(
        "output",
        expect.stringContaining('error: script "lint" exited with code 1'),
      );
      expect(ledgered(ledger)).toEqual(["typecheck", "lint"]);
    },
    processWatchdog(1),
  );

  test(
    "a lockfile that does not match its manifest is red at the frozen install, before any script runs",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const { commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(ledger, "typecheck", "true"),
          lint: ledgerScript(ledger, "lint", "true"),
        },
      });
      const red = commit("keep a lockfile for a removed dependency", {
        "bun.lock": lockfileListingADroppedDependency,
      });

      const checked = await check(run, red);

      expect(checked).toMatchObject({
        ...red,
        result: { status: "red", failed: ["install", "--frozen-lockfile"] },
      });
      expect(checked.result).toHaveProperty(
        "output",
        expect.stringContaining(
          "error: lockfile had changes, but lockfile is frozen",
        ),
      );
      expect(ledgered(ledger)).toEqual([]);
    },
    processWatchdog(1),
  );

  test(
    "a commit git cannot check out is refused with git's own message and leaves no worktree behind",
    async () => {
      const { root, run } = repositoryAt();
      const sha = "0".repeat(40);

      await inTemporaryFolder(async (temporary) => {
        expect(
          await refusal(
            check(run, { sha, short: "0000000", subject: "no such commit" }),
          ),
        ).toBe(`fatal: invalid reference: ${sha}`);
        expect(readdirSync(temporary)).toEqual([]);
      });

      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a step killed by a signal gives no verdict, names the step and the commit, and leaves no worktree behind",
    async () => {
      const { root, commit, run } = repositoryAt({
        scripts: { typecheck: "kill -KILL $PPID", lint: "true" },
      });
      const killed = commit("kill the typecheck", { "a.txt": "a" });

      await inTemporaryFolder(async (temporary) => {
        expect(await refusal(check(run, killed))).toBe(
          `bun run typecheck was killed by SIGKILL while checking ${killed.short}, so it has no verdict.`,
        );
        expect(readdirSync(temporary)).toEqual([]);
      });

      expect(registered(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a worktree a step locked is still released, with its administrative folder, and nothing is printed",
    async () => {
      const { root, run, commit } = repositoryAt({
        scripts: {
          typecheck: 'git worktree lock "$PWD"',
          lint: "true",
        },
      });
      const locked = commit("lock the worktree from a step", { "a.txt": "a" });

      const shown = await inTemporaryFolder(async (temporary) => {
        const result = await captured(() => check(run, locked));
        expect(readdirSync(temporary)).toEqual([]);
        return result;
      });

      expect(shown.value).toEqual({ ...locked, result: { status: "green" } });
      expect(shown.stderr).toBe("");
      expect(registered(root)).toEqual([`worktree ${realpathSync(root)}`]);
      expect(readdirSync(join(root, ".git", "worktrees"))).toEqual([]);
    },
    processWatchdog(1),
  );
});

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
