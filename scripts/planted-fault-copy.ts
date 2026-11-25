import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { place, sourceIn } from "./planted-fault-patch.ts";
import {
  faultedVerdict,
  unparsedFiles,
  type Verdict,
} from "./planted-fault-verdict.ts";
import { readOptionalUtf8 } from "./read-file.ts";

export type Step = (
  id: string,
  cwd: string,
  argv: readonly string[],
  limitMilliseconds: number,
) => Promise<{ passed: boolean; output: string }>;

export type Copy = {
  readonly folder: string;
  readonly dir: string;
  readonly tracked: ReadonlySet<string>;
};

const baselineRef = "refs/fault-replay/baseline";

const ownGitSteps: readonly (readonly string[])[] = [
  ["git", "init", "-q", "--initial-branch=main"],
  ["git", "add", "-A", "-f"],
  [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "user.name=fault-replay",
    "-c",
    "user.email=fault-replay@localhost",
    "commit",
    "-q",
    "--no-verify",
    "--allow-empty",
    "-m",
    "fault-replay: working tree",
  ],
  ["git", "update-ref", baselineRef, "HEAD"],
];

const resetCopySteps: readonly (readonly string[])[] = [
  ["git", "reset", "--hard", "-q", baselineRef],
  ["git", "clean", "-fd", "-q", "-e", "node_modules"],
];

async function initOwnGit(
  dir: string,
  id: string,
  limitMilliseconds: number,
  runStep: Step,
): Promise<void> {
  for (const argv of ownGitSteps) {
    const done = await runStep(id, dir, argv, limitMilliseconds);
    if (!done.passed) throw new Error(done.output.trim());
  }
}

async function resetCopy(
  dir: string,
  id: string,
  limitMilliseconds: number,
  runStep: Step,
): Promise<void> {
  for (const argv of resetCopySteps) {
    const done = await runStep(id, dir, argv, limitMilliseconds);
    if (!done.passed) throw new Error(done.output.trim());
  }
}

async function installDependencies(
  dir: string,
  id: string,
  limitMilliseconds: number,
  runStep: Step,
): Promise<void> {
  const installed = await runStep(
    id,
    dir,
    [process.execPath, "install", "--frozen-lockfile"],
    limitMilliseconds,
  );
  if (!installed.passed)
    throw new Error(
      `bun install --frozen-lockfile failed while replaying ${id}:\n${installed.output}`,
    );
}

function copyListedFiles(
  root: string,
  dir: string,
  listedOutput: string,
): Set<string> {
  const tracked = new Set<string>();
  for (const path of new Set(listedOutput.split("\0"))) {
    if (path === "") continue;
    const source = join(root, path);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (stat === undefined || (!stat.isFile() && !stat.isSymbolicLink()))
      continue;
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { verbatimSymlinks: true });
    tracked.add(path);
  }
  return tracked;
}

export async function copyWorkingTree(
  root: string,
  id: string,
  limitMilliseconds: number,
  runStep: Step,
): Promise<Copy> {
  const listed = await runStep(
    id,
    root,
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    limitMilliseconds,
  );
  if (!listed.passed) throw new Error(listed.output.trim());
  const folder = mkdtempSync(join(tmpdir(), "fault-replay-"));
  const dir = join(folder, "tree");
  mkdirSync(dir);
  try {
    const tracked = copyListedFiles(root, dir, listed.output);
    await initOwnGit(dir, id, limitMilliseconds, runStep);
    await installDependencies(dir, id, limitMilliseconds, runStep);
    return { folder, dir, tracked };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

export async function copyCommit(
  root: string,
  commit: string,
  id: string,
  limitMilliseconds: number,
  runStep: Step,
): Promise<Copy> {
  const folder = mkdtempSync(join(tmpdir(), "fault-replay-"));
  const dir = join(folder, "tree");
  mkdirSync(dir);
  try {
    const archive = join(folder, "tree.tar");
    const archived = await runStep(
      id,
      root,
      ["git", "archive", "--format=tar", "-o", archive, commit],
      limitMilliseconds,
    );
    if (!archived.passed) throw new Error(archived.output.trim());
    const extracted = await runStep(
      id,
      dir,
      ["tar", "-xf", archive, "-C", dir],
      limitMilliseconds,
    );
    rmSync(archive, { force: true });
    if (!extracted.passed) throw new Error(extracted.output.trim());
    await initOwnGit(dir, id, limitMilliseconds, runStep);
    const listed = await runStep(
      id,
      dir,
      ["git", "ls-files", "-z"],
      limitMilliseconds,
    );
    if (!listed.passed) throw new Error(listed.output.trim());
    const tracked = new Set(listed.output.split("\0").filter((p) => p !== ""));
    await installDependencies(dir, id, limitMilliseconds, runStep);
    return { folder, dir, tracked };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

export async function replayInCopy(
  copy: Copy,
  fault: {
    readonly id: string;
    readonly patch: string;
    readonly testFile: string;
    readonly title: string;
  },
  patch: string,
  limitMilliseconds: number,
  runStep: Step,
): Promise<Verdict> {
  const placement = place(fault.patch, patch, sourceIn(copy.dir, copy.tracked));
  if (placement.kind === "refused")
    return { kind: "STALE", output: placement.cause };
  const testArgs = ["test", `./${fault.testFile}`, "-t", fault.title];
  const bunInTree = (argv: readonly string[]) =>
    runStep(fault.id, copy.dir, [process.execPath, ...argv], limitMilliseconds);
  const reportPath = join(copy.folder, "junit.xml");
  rmSync(reportPath, { force: true });
  try {
    const clean = await bunInTree(testArgs);
    if (!clean.passed) return { kind: "BROKEN", output: clean.output };
    const unparsed = unparsedFiles(placement.files);
    if (unparsed !== undefined) return { kind: "UNPARSED", ...unparsed };
    for (const [path, text] of placement.files)
      writeFileSync(join(copy.dir, path), text);
    const faulted = await bunInTree([
      ...testArgs,
      "--reporter=junit",
      `--reporter-outfile=${reportPath}`,
    ]);
    if (faulted.passed) return { kind: "SURVIVED" };
    return faultedVerdict(
      faulted.output,
      readOptionalUtf8(reportPath),
      fault.title,
    );
  } finally {
    rmSync(reportPath, { force: true });
    await resetCopy(copy.dir, fault.id, limitMilliseconds, runStep);
  }
}
