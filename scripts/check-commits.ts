import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runWithOwnTools,
  startChild,
  stepLimitMilliseconds,
  withoutRepositoryLocation,
} from "./process-runner.ts";
import { doctor } from "./doctor.ts";
import { readRepository } from "./repository.ts";

const stepLimitVariable = "CHECK_COMMITS_STEP_SECONDS";
const defaultStepLimitSeconds = 300;

const steps = [
  ["install", "--frozen-lockfile"],
  ["run", "typecheck"],
  ["run", "lint"],
] as const;

export type Step = (typeof steps)[number];
export type Commit = { sha: string; short: string; subject: string };
export type Result =
  | { status: "green" }
  | { status: "red"; failed: Step; output: string };
export type Checked = Commit & { result: Result };

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
export type StopSignal = (typeof signals)[number];
export type Active = { stop?: () => void; stoppedBy?: StopSignal };
export type Run = {
  readonly root: string;
  readonly fixedPoint: string;
  readonly active: Active;
  readonly limitMilliseconds?: number;
};

function limitOf(run: Run): number {
  return (
    run.limitMilliseconds ??
    stepLimitMilliseconds(
      process.env,
      stepLimitVariable,
      defaultStepLimitSeconds,
    )
  );
}

function isStopSignal(
  signal: NodeJS.Signals | number | null | undefined,
): signal is StopSignal {
  return signals.some((each) => each === signal);
}

async function git(run: Run, args: readonly string[]) {
  const { root, active } = run;
  const limit = limitOf(run);
  const child = startChild(["git", ...args], {
    cwd: root,
    env: withoutRepositoryLocation(process.env),
    limitMilliseconds: limit,
  });
  active.stop = child.stop;
  let result;
  try {
    result = await child.finished;
  } finally {
    delete active.stop;
  }
  if (!result.timedOut && isStopSignal(result.signalCode))
    active.stoppedBy ??= result.signalCode;
  if (result.timedOut)
    throw new Error(
      `FAIL check:commits: git ${args.join(" ")} did not finish within ${limit / 1000} s. Repair: run git ${args.join(" ")} by hand in ${root} to see where it hangs, or raise ${stepLimitVariable}.`,
    );
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function shown(step: Step): string {
  return `bun ${step.join(" ")}`;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function adminFolderOf(
  run: Run,
  dir: string,
): Promise<string | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const found = await git(run, [
    "-C",
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  return found.ok ? found.stdout.trim() : undefined;
}

function pointsBackTo(admin: string, dir: string): boolean {
  const gitdir = join(admin, "gitdir");
  return (
    existsSync(gitdir) &&
    resolve(readFileSync(gitdir, "utf8").trim()) === join(dir, ".git")
  );
}

// Platform: `git worktree prune` unregisters a worktree whose folder is gone by
// deleting its administrative folder.
function pruneOnlyThisWorktree(admin: string): void {
  rmSync(admin, { recursive: true, force: true });
}

export async function release(
  run: Run,
  dir: string,
  admin: string | undefined,
): Promise<void> {
  const owned = admin !== undefined && pointsBackTo(admin, dir);
  let removed = false;
  let removalFailure: Error | undefined;
  try {
    removed = (await git(run, ["worktree", "remove", "--force", dir])).ok;
  } catch (error) {
    removalFailure = error instanceof Error ? error : new Error(String(error));
  }
  rmSync(dir, { recursive: true, force: true });
  if (!removed && admin !== undefined && existsSync(admin)) {
    if (owned) pruneOnlyThisWorktree(admin);
    else
      process.stderr.write(
        `git worktree remove failed for ${dir}, and ${admin} no longer names it, so that registration stays. Repair: git worktree prune\n`,
      );
  }
  if (removalFailure !== undefined) throw removalFailure;
}

function haltIfStopped({ active }: Run, commit: Commit): void {
  if (active.stoppedBy !== undefined)
    throw new Error(
      `Stopped by ${active.stoppedBy} while checking ${commit.short}, so it has no verdict.`,
    );
}

export async function check(run: Run, commit: Commit): Promise<Checked> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-commits-")));
  const limit = limitOf(run);
  let admin: string | undefined;
  try {
    const added = await git(run, [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      dir,
      commit.sha,
    ]);
    admin = await adminFolderOf(run, dir);
    haltIfStopped(run, commit);
    if (!added.ok) throw new Error(added.stderr.trim());
    for (const step of steps) {
      const { exitCode, signalCode, timedOut, output } = await runWithOwnTools(
        [process.execPath, ...step],
        dir,
        run.active,
        { limitMilliseconds: limit },
      );
      haltIfStopped(run, commit);
      if (timedOut)
        throw new Error(
          `FAIL check:commits: ${shown(step)} did not finish within ${limit / 1000} s while checking ${commit.short}, so it has no verdict. Repair: run ${shown(step)} by hand to see where it hangs, or raise ${stepLimitVariable}.`,
        );
      if (signalCode !== null)
        throw new Error(
          `${shown(step)} was killed by ${signalCode} while checking ${commit.short}, so it has no verdict.`,
        );
      if (exitCode !== 0)
        return { ...commit, result: { status: "red", failed: step, output } };
    }
    return { ...commit, result: { status: "green" } };
  } finally {
    await release(run, dir, admin);
  }
}

function report(
  { fixedPoint }: Run,
  { sha, short, subject, result }: Checked,
): void {
  if (result.status === "green") {
    print(`GREEN ${short} ${subject}`);
    return;
  }
  print(`RED ${short} ${subject}`);
  print(`Failed: ${shown(result.failed)}`);
  print(
    `Repair: change ${short} itself so that ${shown(result.failed)} passes at that commit.`,
  );
  print(
    `Rerun locally: CHECK_COMMITS_SINCE='${fixedPoint}' bun run check:commits '${sha}^@' ${sha}`,
  );
  process.stdout.write(result.output.replace(/\n?$/, "\n"));
}

async function commitsToCheck(
  run: Run,
  base: string,
  head: string,
): Promise<Commit[]> {
  const { fixedPoint } = run;
  const present = (await git(run, ["cat-file", "-e", `${fixedPoint}^{commit}`]))
    .ok;
  const behind =
    present &&
    (await git(run, ["merge-base", "--is-ancestor", fixedPoint, head])).ok;
  if (!present)
    print(
      `since ${fixedPoint} is not in this clone, so every commit in ${base}..${head} is checked.`,
    );
  else if (!behind)
    print(
      `since ${fixedPoint} is not behind ${head}, so every commit in ${base}..${head} is checked.`,
    );
  const listed = await git(run, [
    "rev-list",
    "--reverse",
    "--no-commit-header",
    "--format=%H %h %s",
    head,
    ...(behind ? [`^${fixedPoint}`] : []),
    "--not",
    base,
  ]);
  if (!listed.ok) throw new Error(listed.stderr.trim());
  return listed.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", short = "", ...subject] = line.split(" ");
      return { sha, short, subject: subject.join(" ") };
    });
}

type Shard = { readonly part: number; readonly parts: number };

const shardPattern = /^(?<part>[1-9]\d*)\/(?<parts>[1-9]\d*)$/;

function shardOf(argv: readonly string[]): Shard | string {
  const [, given, ...extra] = argv;
  const found = shardPattern.exec(given ?? "")?.groups;
  const part = Number(found?.part);
  const parts = Number(found?.parts);
  if (found === undefined || part > parts || extra.length > 0)
    return `Usage: bun run check:commits <base> [head] --shard <part>/<parts>, with whole numbers 1 <= part <= parts. Got '${argv.join(" ")}'. Repair: pass one part, such as --shard 2/4.\n`;
  return { part, parts };
}

function blockOf<T>(items: readonly T[], { part, parts }: Shard): T[] {
  const edge = (at: number) => Math.floor((at * items.length) / parts);
  return items.slice(edge(part - 1), edge(part));
}

export async function main(argv: readonly string[], run: Run): Promise<number> {
  const at = argv.indexOf("--shard");
  const [base, head = "HEAD"] = at === -1 ? argv : argv.slice(0, at);
  const shard = at === -1 ? undefined : shardOf(argv.slice(at));
  if (base === undefined) {
    process.stderr.write("Usage: bun run check:commits <base> [head]\n");
    return 2;
  }
  if (typeof shard === "string") {
    process.stderr.write(shard);
    return 2;
  }
  if (!(await doctor(run.root, run.active))) {
    print("Refused: repair the doctor's FAIL lines, then rerun.");
    return 1;
  }
  let commits = await commitsToCheck(run, base, head);
  if (commits.length === 0) {
    print(
      `No commits in ${base}..${head} to check, so this gate checks nothing. Repair: name a base that ${head} is ahead of.`,
    );
    return 1;
  }
  if (shard !== undefined) {
    const inRange = commits.length;
    commits = blockOf(commits, shard);
    if (commits.length === 0) {
      print(
        `Part ${shard.part} of ${shard.parts} holds none of the ${inRange} commits in ${base}..${head}, so the other parts check them.`,
      );
      return 0;
    }
  }
  const started = performance.now();
  let red = 0;
  for (const commit of commits) {
    const checked = await check(run, commit);
    haltIfStopped(run, commit);
    report(run, checked);
    if (checked.result.status === "red") red += 1;
  }
  const seconds = (performance.now() - started) / 1000;
  const pace = ` in ${seconds.toFixed(1)} s, ${(seconds / commits.length).toFixed(1)} s per commit`;
  if (red > 0) {
    print(`${red} of ${commits.length} commits are red${pace}.`);
    return 1;
  }
  print(`Checked ${commits.length} commits: all green${pace}.`);
  return 0;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const active: Active = {};
  for (const signal of signals)
    process.on(signal, () => {
      active.stoppedBy ??= signal;
      active.stop?.();
    });

  try {
    const run: Run = {
      root,
      fixedPoint:
        process.env.CHECK_COMMITS_SINCE ||
        readRepository(root).checkCommitsSince,
      active,
      limitMilliseconds: stepLimitMilliseconds(
        process.env,
        stepLimitVariable,
        defaultStepLimitSeconds,
      ),
    };
    process.exitCode = await main(process.argv.slice(2), run);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
  if (active.stoppedBy !== undefined)
    process.exitCode = 128 + constants.signals[active.stoppedBy];
}
