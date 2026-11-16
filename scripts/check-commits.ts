import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { runWithOwnTools } from "./child-env.ts";
import { doctor } from "./doctor.ts";

// The head of codex/contract-3-foundation when this gate was written. A commit
// cannot hold its own SHA, so this is the nearest fixed point; the older
// commits, some of them red, never fail the gate.
const since = "f20777f7e67d300ade253060fa2ba36f38c0ca43";
const root = join(import.meta.dir, "..");
const steps = [
  ["install", "--frozen-lockfile"],
  ["run", "typecheck"],
  ["run", "lint"],
] as const;

type Step = (typeof steps)[number];
type Commit = { sha: string; short: string; subject: string };
type Result =
  | { status: "green" }
  | { status: "red"; failed: Step; output: string };
type Checked = Commit & { result: Result };

// Ctrl-C sends SIGINT, a closing terminal SIGHUP, a CI cancel SIGINT then
// SIGTERM.
const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
type StopSignal = (typeof signals)[number];
const active: { child?: Subprocess; stoppedBy?: StopSignal } = {};

function isStopSignal(signal: string | undefined): signal is StopSignal {
  return signals.some((each) => each === signal);
}

function git(args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  // A signal to the whole process group kills git before this process's
  // handler can run, so git's own death is the evidence of the stop.
  if (isStopSignal(result.signalCode)) active.stoppedBy ??= result.signalCode;
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const worktreesFolder = join(
  git([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).stdout.trim(),
  "worktrees",
);

function shown(step: Step): string {
  return `bun ${step.join(" ")}`;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function adminFolderOf(link: string): string | undefined {
  const admin = resolve(
    dirname(link),
    readFileSync(link, "utf8")
      .replace(/^gitdir: /, "")
      .trim(),
  );
  return dirname(admin) === worktreesFolder ? admin : undefined;
}

// Deleting this one worktree's admin folder is what `git worktree prune`
// does for it, without pruning anyone else's worktree. The checked commit's
// own steps can rewrite its .git file, so only a folder under the common
// worktrees folder is ever deleted.
function release(dir: string): void {
  const link = join(dir, ".git");
  const registered = existsSync(link);
  const admin = registered ? adminFolderOf(link) : undefined;
  const removed = git(["worktree", "remove", "--force", dir]).ok;
  rmSync(dir, { recursive: true, force: true });
  if (removed || !registered) return;
  if (admin === undefined)
    process.stderr.write(
      `git worktree remove failed for ${dir}, and its .git file points outside ${worktreesFolder}, so its registration stays. Repair: git worktree prune\n`,
    );
  else rmSync(admin, { recursive: true, force: true });
}

function haltIfStopped(commit: Commit): void {
  if (active.stoppedBy !== undefined)
    throw new Error(
      `Stopped by ${active.stoppedBy} while checking ${commit.short}, so it has no verdict.`,
    );
}

async function check(commit: Commit): Promise<Checked> {
  const dir = mkdtempSync(join(tmpdir(), "check-commits-"));
  try {
    const added = git([
      "worktree",
      "add",
      "--detach",
      "--quiet",
      dir,
      commit.sha,
    ]);
    haltIfStopped(commit);
    if (!added.ok) throw new Error(added.stderr.trim());
    for (const step of steps) {
      const { exitCode, signalCode, output } = await runWithOwnTools(
        [process.execPath, ...step],
        dir,
        active,
      );
      haltIfStopped(commit);
      if (signalCode !== null)
        throw new Error(
          `${shown(step)} was killed by ${signalCode} while checking ${commit.short}, so it has no verdict.`,
        );
      if (exitCode !== 0)
        return { ...commit, result: { status: "red", failed: step, output } };
    }
    return { ...commit, result: { status: "green" } };
  } finally {
    release(dir);
  }
}

function report({ sha, short, subject, result }: Checked): void {
  if (result.status === "green") {
    print(`GREEN ${short} ${subject}`);
    return;
  }
  const failedAt = steps.indexOf(result.failed);
  const rerun = steps
    .slice(0, failedAt + 1)
    .map(shown)
    .join(" && ");
  const folder = `"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.worktrees/red-${short}"`;
  print(`RED ${short} ${subject}`);
  print(`Failed: ${shown(result.failed)}`);
  print(
    `Rerun locally: bun run doctor && (folder=${folder} && { test -d "$folder" || git worktree add --detach "$folder" ${sha}; } && cd "$folder" && ${rerun})`,
  );
  print(`Clean up: git worktree remove ${folder}`);
  process.stdout.write(result.output.replace(/\n?$/, "\n"));
}

function commitsToCheck(base: string, head: string): Commit[] {
  const fixedPoint = process.env.CHECK_COMMITS_SINCE || since;
  const present = git(["cat-file", "-e", `${fixedPoint}^{commit}`]).ok;
  if (!present)
    print(
      `since ${fixedPoint} is not in this clone, so every commit in ${base}..${head} is checked.`,
    );
  const listed = git([
    "rev-list",
    "--reverse",
    "--no-commit-header",
    "--format=%H %h %s",
    `${base}..${head}`,
    ...(present ? [`^${fixedPoint}`] : []),
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

for (const signal of signals)
  process.on(signal, () => {
    active.stoppedBy ??= signal;
    active.child?.kill("SIGTERM");
  });

async function main(argv: readonly string[]): Promise<number> {
  const [base, head = "HEAD"] = argv;
  if (base === undefined) {
    process.stderr.write("Usage: bun run check:commits <base> [head]\n");
    return 2;
  }
  if (!(await doctor(root))) {
    print("Refused: repair the doctor's FAIL lines, then rerun.");
    return 1;
  }
  const commits = commitsToCheck(base, head);
  const started = performance.now();
  let red = 0;
  for (const commit of commits) {
    const checked = await check(commit);
    haltIfStopped(commit);
    report(checked);
    if (checked.result.status === "red") red += 1;
  }
  const seconds = (performance.now() - started) / 1000;
  const pace =
    commits.length === 0
      ? ""
      : ` in ${seconds.toFixed(1)} s, ${(seconds / commits.length).toFixed(1)} s per commit`;
  if (red > 0) {
    print(`${red} of ${commits.length} commits are red${pace}.`);
    return 1;
  }
  print(`Checked ${commits.length} commits: all green${pace}.`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
if (active.stoppedBy !== undefined)
  process.exitCode = 128 + constants.signals[active.stoppedBy];
