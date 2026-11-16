import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { doctor } from "./doctor.ts";

// The head of codex/contract-3-foundation when this gate was written. A commit
// cannot hold its own SHA, so this is the nearest fixed point; the older
// commits, some of them red, never fail the gate.
const since = "f20777f7e67d300ade253060fa2ba36f38c0ca43";
const fixedPoint = process.env.CHECK_COMMITS_SINCE || since;
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
const active: {
  child?: Subprocess;
  stoppedBy?: StopSignal;
  escalation?: Timer;
} = {};
const graceMilliseconds = 2_000;
// `bun run` prepends the caller's node_modules/.bin folders to PATH. Drop
// them so a commit sees only what its own tree installs.
const ownTools = {
  ...process.env,
  PATH: (process.env.PATH ?? "")
    .split(delimiter)
    .filter(
      (entry) =>
        basename(entry) !== ".bin" ||
        basename(dirname(entry)) !== "node_modules",
    )
    .join(delimiter),
};

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

function shown(step: Step): string {
  return `bun ${step.join(" ")}`;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

// Read before any checked step runs, because those steps can rewrite the
// worktree's .git file to name another registration.
function adminFolderOf(dir: string): string | undefined {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const found = git([
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

// Deleting this one worktree's admin folder is what `git worktree prune`
// does for it, without pruning anyone else's worktree.
function release(dir: string, admin: string | undefined): void {
  const owned = admin !== undefined && pointsBackTo(admin, dir);
  const removed = git(["worktree", "remove", "--force", dir]).ok;
  rmSync(dir, { recursive: true, force: true });
  if (removed || admin === undefined || !existsSync(admin)) return;
  if (owned) rmSync(admin, { recursive: true, force: true });
  else
    process.stderr.write(
      `git worktree remove failed for ${dir}, and ${admin} no longer names it, so that registration stays. Repair: git worktree prune\n`,
    );
}

function haltIfStopped(commit: Commit): void {
  if (active.stoppedBy !== undefined)
    throw new Error(
      `Stopped by ${active.stoppedBy} while checking ${commit.short}, so it has no verdict.`,
    );
}

// Each step leads its own process group, so a stop reaches every process the
// step started, not only the direct child.
function signalGroup(child: Subprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function run(cwd: string, step: Step) {
  const child = Bun.spawn([process.execPath, ...step], {
    cwd,
    env: ownTools,
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  active.child = child;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  delete active.child;
  clearTimeout(active.escalation);
  // A descendant that closed its output would otherwise outlive the stop.
  if (active.stoppedBy !== undefined) signalGroup(child, "SIGKILL");
  return { exitCode, signalCode: child.signalCode, output: stdout + stderr };
}

async function check(commit: Commit): Promise<Checked> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-commits-")));
  let admin: string | undefined;
  try {
    const added = git([
      "worktree",
      "add",
      "--detach",
      "--quiet",
      dir,
      commit.sha,
    ]);
    admin = adminFolderOf(dir);
    haltIfStopped(commit);
    if (!added.ok) throw new Error(added.stderr.trim());
    for (const step of steps) {
      const { exitCode, signalCode, output } = await run(dir, step);
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
    release(dir, admin);
  }
}

function report({ sha, short, subject, result }: Checked): void {
  if (result.status === "green") {
    print(`GREEN ${short} ${subject}`);
    return;
  }
  print(`RED ${short} ${subject}`);
  print(`Failed: ${shown(result.failed)}`);
  print(
    `Rerun locally: CHECK_COMMITS_SINCE='${fixedPoint}' bun run check:commits '${sha}^@' ${sha}`,
  );
  process.stdout.write(result.output.replace(/\n?$/, "\n"));
}

function commitsToCheck(base: string, head: string): Commit[] {
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
    head,
    ...(present ? [`^${fixedPoint}`] : []),
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

for (const signal of signals)
  process.on(signal, () => {
    active.stoppedBy ??= signal;
    const { child } = active;
    if (child === undefined) return;
    signalGroup(child, "SIGTERM");
    active.escalation ??= setTimeout(
      () => signalGroup(child, "SIGKILL"),
      graceMilliseconds,
    );
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
