import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { ownTools } from "./child-env.ts";

const root = join(import.meta.dir, "..");
const manifestPath = "tests/faults/manifest.json";
const patchFolder = "tests/faults/patches";

type Fault = {
  id: string;
  patch: string;
  testFile: string;
  title: string;
  source: string;
};
type Verdict =
  | { kind: "KILLED"; failing: readonly string[] }
  | { kind: "SURVIVED" }
  | { kind: "STALE"; output: string }
  | { kind: "BROKEN"; output: string };

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
// The step's group has no live process to stop. ESRCH: every member is
// reaped. EPERM: macOS answers it when every member left is a zombie.
const groupGone = new Set<unknown>(["ESRCH", "EPERM"]);
const active: { child?: Subprocess; stoppedBy?: (typeof signals)[number] } = {};
const snapshotAuthor = {
  GIT_AUTHOR_NAME: "faults",
  GIT_AUTHOR_EMAIL: "faults@localhost",
  GIT_COMMITTER_NAME: "faults",
  GIT_COMMITTER_EMAIL: "faults@localhost",
};

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Every child gets its own process group, so a terminal's group signal
// reaches only this script, which stops the child and then cleans up.
function git(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function gitOrThrow(
  args: readonly string[],
  env?: Record<string, string | undefined>,
): string {
  const result = git(args, env);
  if (!result.ok)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

function parseFault(entry: unknown, index: number): Fault {
  const own = new Map<string, unknown>(
    typeof entry === "object" && entry !== null ? Object.entries(entry) : [],
  );
  const field = (name: keyof Fault): string => {
    const value = own.get(name);
    if (typeof value !== "string" || value === "")
      throw new Error(
        `${manifestPath} record ${index} needs a non-empty string ${name}.`,
      );
    return value;
  };
  return {
    id: field("id"),
    patch: field("patch"),
    testFile: field("testFile"),
    title: field("title"),
    source: field("source"),
  };
}

function readManifest(): Fault[] {
  const path = join(root, manifestPath);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error(`${manifestPath} must hold an array of fault records.`);
  const faults = parsed.map(parseFault);
  const ids = new Set<string>();
  for (const { id } of faults) {
    if (ids.has(id)) throw new Error(`${manifestPath} lists ${id} twice.`);
    ids.add(id);
  }
  return faults;
}

function commitWorkingTreeInScratchIndex(): string {
  const folder = mkdtempSync(join(tmpdir(), "faults-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(folder, "index") };
    gitOrThrow(["read-tree", "HEAD"], env);
    gitOrThrow(["add", "--all"], env);
    const tree = gitOrThrow(["write-tree"], env).trim();
    if (tree === gitOrThrow(["rev-parse", "HEAD^{tree}"]).trim())
      return gitOrThrow(["rev-parse", "HEAD"]).trim();
    return gitOrThrow(
      ["commit-tree", tree, "-p", "HEAD", "-m", "faults: working tree"],
      { ...process.env, ...snapshotAuthor },
    ).trim();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function step(id: string, cwd: string, argv: readonly string[]) {
  const child = Bun.spawn([...argv], {
    cwd,
    env: ownTools,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  active.child = child;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  delete active.child;
  if (active.stoppedBy !== undefined)
    throw new Error(
      `Stopped by ${active.stoppedBy} while replaying ${id}, so it has no verdict.`,
    );
  if (child.signalCode !== null)
    throw new Error(
      `${argv.join(" ")} was killed by ${child.signalCode} while replaying ${id}, so it has no verdict.`,
    );
  return { passed: exitCode === 0, output: stdout + stderr };
}

function failingTests(output: string): string[] {
  return [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(
    (match) => match[1] ?? "",
  );
}

function testArgs(fault: Fault): string[] {
  return ["test", `./${fault.testFile}`, "-t", fault.title];
}

async function replay(fault: Fault, commit: string): Promise<Verdict> {
  const patch = join(root, fault.patch);
  const folder = mkdtempSync(join(tmpdir(), "faults-"));
  const dir = join(folder, "tree");
  const gitInTree = (argv: readonly string[]) =>
    step(fault.id, dir, ["git", ...argv]);
  const bunInTree = (argv: readonly string[]) =>
    step(fault.id, dir, [process.execPath, ...argv]);
  try {
    const added = await step(fault.id, root, [
      "git",
      "worktree",
      "add",
      "--detach",
      "--quiet",
      dir,
      commit,
    ]);
    if (!added.passed) throw new Error(added.output.trim());
    const applies = await gitInTree(["apply", "--check", patch]);
    if (!applies.passed) return { kind: "STALE", output: applies.output };
    const installed = await bunInTree(["install", "--frozen-lockfile"]);
    if (!installed.passed)
      throw new Error(
        `bun install --frozen-lockfile failed while replaying ${fault.id}:\n${installed.output}`,
      );
    const clean = await bunInTree(testArgs(fault));
    if (!clean.passed) return { kind: "BROKEN", output: clean.output };
    const applied = await gitInTree(["apply", patch]);
    if (!applied.passed) throw new Error(applied.output.trim());
    const faulted = await bunInTree(testArgs(fault));
    if (faulted.passed) return { kind: "SURVIVED" };
    return { kind: "KILLED", failing: failingTests(faulted.output) };
  } finally {
    git(["worktree", "remove", "--force", dir]);
    rmSync(folder, { recursive: true, force: true });
  }
}

function report(fault: Fault, verdict: Verdict, seconds: number): void {
  const took = `in ${seconds.toFixed(1)} s`;
  const shown = `bun test ./${fault.testFile} -t ${quoted(fault.title)}`;
  const rerun = `Rerun: bun run faults ${fault.id}`;
  switch (verdict.kind) {
    case "KILLED":
      print(
        `KILLED ${fault.id} ${took}. Failed: ${verdict.failing.join(" | ") || "the test file, which did not load"}`,
      );
      return;
    case "SURVIVED":
      print(
        `SURVIVED ${fault.id} ${took}. ${shown} passed with ${fault.patch} applied, so no test catches this fault.`,
      );
      print(rerun);
      return;
    case "STALE":
      print(
        `STALE ${fault.id} ${took}. ${fault.patch} no longer applies at this head.`,
      );
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(
        `Plant the fault again by hand, save it with: git diff > ${fault.patch}`,
      );
      print(rerun);
      return;
    case "BROKEN":
      print(
        `BROKEN ${fault.id} ${took}. ${shown} fails without the fault, so the fault proves nothing.`,
      );
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(rerun);
      return;
  }
}

async function replayAll(ids: readonly string[]): Promise<number> {
  const faults = readManifest();
  const unknown = ids.filter((id) => !faults.some((fault) => fault.id === id));
  if (unknown.length > 0) {
    process.stderr.write(
      `No fault ${unknown.join(", ")} in ${manifestPath}.\n`,
    );
    return 2;
  }
  const chosen =
    ids.length === 0 ? faults : faults.filter(({ id }) => ids.includes(id));
  if (chosen.length === 0) {
    print(`No faults recorded in ${manifestPath}.`);
    return 0;
  }
  const commit = commitWorkingTreeInScratchIndex();
  const started = performance.now();
  let killed = 0;
  for (const fault of chosen) {
    const begun = performance.now();
    const verdict = await replay(fault, commit);
    report(fault, verdict, (performance.now() - begun) / 1000);
    if (verdict.kind === "KILLED") killed += 1;
  }
  const seconds = (performance.now() - started) / 1000;
  print(
    `${killed} of ${chosen.length} faults KILLED in ${seconds.toFixed(1)} s, ${(seconds / chosen.length).toFixed(1)} s per fault, with Bun ${Bun.version}.`,
  );
  return killed === chosen.length ? 0 : 1;
}

function add(argv: readonly string[]): number {
  const [sha, sourcePath, testFile, title] = argv;
  if (
    sha === undefined ||
    sourcePath === undefined ||
    testFile === undefined ||
    title === undefined
  ) {
    process.stderr.write(
      "Usage: bun run faults:add <fix sha> <source path> <test file> <title>\n",
    );
    return 2;
  }
  const full = gitOrThrow(["rev-parse", "--verify", `${sha}^{commit}`]).trim();
  const short = gitOrThrow(["rev-parse", "--short", full]).trim();
  const subject = gitOrThrow(["log", "-1", "--format=%s", full]).trim();
  const reverse = gitOrThrow(["diff", full, `${full}^`, "--", sourcePath]);
  if (reverse === "") {
    process.stderr.write(`${short} does not change ${sourcePath}.\n`);
    return 2;
  }
  const id = `${short}-${basename(sourcePath).replace(/\.[^.]+$/, "")}`;
  const faults = readManifest();
  if (faults.some((fault) => fault.id === id)) {
    process.stderr.write(`${manifestPath} already lists ${id}.\n`);
    return 2;
  }
  const patch = `${patchFolder}/${id}.patch`;
  mkdirSync(join(root, patchFolder), { recursive: true });
  writeFileSync(join(root, patch), reverse);
  faults.push({ id, patch, testFile, title, source: `${short} ${subject}` });
  writeFileSync(
    join(root, manifestPath),
    `${JSON.stringify(faults, null, 2)}\n`,
  );
  print(`Added ${id}. Replay it: bun run faults ${id}`);
  return 0;
}

for (const signal of signals)
  process.on(signal, () => {
    active.stoppedBy ??= signal;
    process.exitCode = 128 + constants.signals[active.stoppedBy];
    const pid = active.child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (!groupGone.has(Reflect.get(Object(error), "code"))) throw error;
    }
  });

async function main([command, ...rest]: readonly string[]): Promise<number> {
  if (command === "replay") return replayAll(rest);
  if (command === "add") return add(rest);
  process.stderr.write(
    "Usage: bun run faults [id ...] | bun run faults:add <fix sha> <source path> <test file> <title>\n",
  );
  return 2;
}

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  code = 2;
}
process.exitCode =
  active.stoppedBy === undefined
    ? code
    : 128 + constants.signals[active.stoppedBy];
