import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { Subprocess } from "bun";
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

const active: { dir?: string; child?: Subprocess } = {};
// `bun run` puts the caller's node_modules/.bin folders on PATH. A commit is
// judged only with what its own tree installs, so its steps never see them.
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

function git(args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
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

function release(dir: string): void {
  git(["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
}

async function run(cwd: string, step: Step) {
  const child = Bun.spawn([process.execPath, ...step], {
    cwd,
    env: ownTools,
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
  return { ok: exitCode === 0, output: stdout + stderr };
}

async function check(commit: Commit): Promise<Checked> {
  const dir = mkdtempSync(join(tmpdir(), "check-commits-"));
  active.dir = dir;
  try {
    const added = git([
      "worktree",
      "add",
      "--detach",
      "--quiet",
      dir,
      commit.sha,
    ]);
    if (!added.ok) throw new Error(added.stderr.trim());
    for (const step of steps) {
      const { ok, output } = await run(dir, step);
      if (!ok)
        return { ...commit, result: { status: "red", failed: step, output } };
    }
    return { ...commit, result: { status: "green" } };
  } finally {
    release(dir);
    delete active.dir;
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
  print(`RED ${short} ${subject}`);
  print(`Failed: ${shown(result.failed)}`);
  print(
    `Rerun locally: git worktree add --detach ../red-${short} ${sha} && cd ../red-${short} && ${rerun}`,
  );
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

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void (async () => {
      active.child?.kill("SIGTERM");
      await active.child?.exited;
      if (active.dir !== undefined) release(active.dir);
      process.exit(128 + constants.signals[signal]);
    })();
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
