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
import { runWithOwnTools } from "./process-runner.ts";

const recordsPath = "tests/planted-faults/fault-records.json";
const patchFolder = "tests/planted-faults/patches";

export type Fault = {
  id: string;
  patch: string;
  testFile: string;
  title: string;
  source: string;
};
export type Verdict =
  | { kind: "KILLED"; failing: readonly string[] }
  | { kind: "SURVIVED" }
  | { kind: "STALE"; output: string }
  | { kind: "BROKEN"; output: string }
  | { kind: "TIMEOUT"; step: string };

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const active: { stop?: () => void; stoppedBy?: (typeof signals)[number] } = {};
const stepLimitVariable = "FAULT_REPLAY_STEP_SECONDS";
const defaultStepLimitSeconds = 300;
const snapshotAuthor = {
  GIT_AUTHOR_NAME: "fault-replay",
  GIT_AUTHOR_EMAIL: "fault-replay@localhost",
  GIT_COMMITTER_NAME: "fault-replay",
  GIT_COMMITTER_EMAIL: "fault-replay@localhost",
};

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function git(
  root: string,
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
  root: string,
  args: readonly string[],
  env?: Record<string, string | undefined>,
): string {
  const result = git(root, args, env);
  if (!result.ok)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

const repairFor: { readonly [name in keyof Fault]: string } = {
  id: "name it <fix short sha>-<source file name>.",
  patch: `name the planted fault's patch under ${patchFolder}.`,
  testFile: "name a test file relative to the repository root.",
  title:
    "name the bun test -t pattern that selects the test that kills the planted fault.",
  source: "name it <fix short sha> <fix subject>.",
};

function parseFault(entry: unknown, where: string, root: string): Fault {
  const own = new Map<string, unknown>(
    typeof entry === "object" && entry !== null ? Object.entries(entry) : [],
  );
  const field = (name: keyof Fault): string => {
    const value = own.get(name);
    if (typeof value !== "string" || value === "")
      throw new Error(
        `${where} needs a non-empty string ${name}. Repair: ${repairFor[name]}`,
      );
    return value;
  };
  const fault = {
    id: field("id"),
    patch: field("patch"),
    testFile: field("testFile"),
    title: field("title"),
    source: field("source"),
  };
  if (!existsSync(join(root, fault.testFile)))
    throw new Error(
      `${where} names testFile ${fault.testFile}, which does not exist. Repair: ${repairFor.testFile}`,
    );
  return fault;
}

export function readRecords(root: string): Fault[] {
  const path = join(root, recordsPath);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error(
      `${recordsPath} must hold an array of fault records. Repair: make its top level one JSON array.`,
    );
  const faults = parsed.map((entry, index) =>
    parseFault(entry, `${recordsPath} record ${index}`, root),
  );
  const ids = new Set<string>();
  for (const { id } of faults) {
    if (ids.has(id))
      throw new Error(
        `${recordsPath} lists ${id} twice. Repair: remove one record, or give it another id.`,
      );
    ids.add(id);
  }
  return faults;
}

function commitWorkingTreeInScratchIndex(root: string): string {
  const folder = mkdtempSync(join(tmpdir(), "fault-replay-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(folder, "index") };
    gitOrThrow(root, ["read-tree", "HEAD"], env);
    gitOrThrow(root, ["add", "--all"], env);
    const tree = gitOrThrow(root, ["write-tree"], env).trim();
    if (tree === gitOrThrow(root, ["rev-parse", "HEAD^{tree}"]).trim())
      return gitOrThrow(root, ["rev-parse", "HEAD"]).trim();
    return gitOrThrow(
      root,
      ["commit-tree", tree, "-p", "HEAD", "-m", "fault-replay: working tree"],
      { ...process.env, ...snapshotAuthor },
    ).trim();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function stepLimitMilliseconds(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const given = env[stepLimitVariable];
  if (given === undefined || given === "")
    return defaultStepLimitSeconds * 1000;
  const seconds = Number(given);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(
      `${stepLimitVariable} is ${quoted(given)}. Repair: set it to a positive number of seconds, or unset it for ${defaultStepLimitSeconds} s.`,
    );
  return seconds * 1000;
}

class StepTimedOut extends Error {
  constructor(readonly step: string) {
    super(`${step} did not finish within its limit.`);
  }
}

function haltIfStopped(id: string): void {
  if (active.stoppedBy !== undefined)
    throw new Error(
      `Stopped by ${active.stoppedBy} while replaying ${id}, so it has no verdict.`,
    );
}

async function step(
  id: string,
  cwd: string,
  argv: readonly string[],
  limitMilliseconds: number,
) {
  const { exitCode, signalCode, timedOut, output } = await runWithOwnTools(
    argv,
    cwd,
    active,
    { limitMilliseconds },
  );
  haltIfStopped(id);
  if (timedOut) throw new StepTimedOut(argv.join(" "));
  if (signalCode !== null)
    throw new Error(
      `${argv.join(" ")} was killed by ${signalCode} while replaying ${id}, so it has no verdict.`,
    );
  return { passed: exitCode === 0, output };
}

function failingTests(output: string): string[] {
  return [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(
    (match) => match[1] ?? "",
  );
}

function testArgs(fault: Fault): string[] {
  return ["test", `./${fault.testFile}`, "-t", fault.title];
}

async function removeWorktree(root: string, dir: string): Promise<void> {
  await Bun.spawn(["git", "worktree", "remove", "--force", dir], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  }).exited;
}

export async function replay(
  root: string,
  fault: Fault,
  commit: string,
  limitMilliseconds: number,
): Promise<Verdict> {
  const patch = join(root, fault.patch);
  const folder = mkdtempSync(join(tmpdir(), "fault-replay-"));
  const dir = join(folder, "tree");
  const gitInTree = (argv: readonly string[]) =>
    step(fault.id, dir, ["git", ...argv], limitMilliseconds);
  const bunInTree = (argv: readonly string[]) =>
    step(fault.id, dir, [process.execPath, ...argv], limitMilliseconds);
  try {
    const added = await step(
      fault.id,
      root,
      ["git", "worktree", "add", "--detach", "--quiet", dir, commit],
      limitMilliseconds,
    );
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
  } catch (error) {
    if (error instanceof StepTimedOut)
      return { kind: "TIMEOUT", step: error.step };
    throw error;
  } finally {
    await removeWorktree(root, dir);
    rmSync(folder, { recursive: true, force: true });
  }
}

export function report(
  fault: Fault,
  verdict: Verdict,
  seconds: number,
  limitMilliseconds: number,
): void {
  const took = `in ${seconds.toFixed(1)} s`;
  const shown = `bun test ./${fault.testFile} -t ${quoted(fault.title)}`;
  const done = `Done when bun run fault-replay ${fault.id} passes.`;
  switch (verdict.kind) {
    case "KILLED":
      print(
        `KILLED ${fault.id} ${took}. Failed: ${verdict.failing.join(" | ") || "the test file, which did not load"}`,
      );
      return;
    case "SURVIVED":
      print(
        `SURVIVED ${fault.id} ${took}. ${shown} passed with ${fault.patch} applied, so no test catches this planted fault.`,
      );
      print(
        `Repair: change ${fault.testFile} so that test fails with the patch applied. ${done}`,
      );
      return;
    case "STALE":
      print(
        `STALE ${fault.id} ${took}. ${fault.patch} no longer applies at this head.`,
      );
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(
        `Repair: plant the fault again by hand, run git diff -- <each file you edited> > ${quoted(fault.patch)}, then undo the planted edit. ${done}`,
      );
      return;
    case "BROKEN":
      print(
        `BROKEN ${fault.id} ${took}. ${shown} fails without the patch, so the planted fault shows nothing.`,
      );
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(`Repair: make that test pass without the patch. ${done}`);
      return;
    case "TIMEOUT":
      print(
        `TIMEOUT ${fault.id} ${took}. ${verdict.step} did not finish within ${limitMilliseconds / 1000} s, so the planted fault has no verdict.`,
      );
      print(
        `Repair: run that step by hand to see where it hangs, or raise ${stepLimitVariable}. ${done}`,
      );
      return;
  }
}

export function faultsTouchedSince(root: string, base: string): string[] {
  if (!git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).ok)
    throw new Error(
      `${base} is not a commit in this repository. Repair: pass a commit or branch, such as origin/main.`,
    );
  const changed = new Set(
    gitOrThrow(root, ["diff", "--name-only", "-z", base, "HEAD"])
      .split("\0")
      .filter((path) => path !== ""),
  );
  const patched = (fault: Fault): string[] =>
    gitOrThrow(root, ["apply", "--numstat", "-z", fault.patch])
      .split("\0")
      .filter((field) => field !== "")
      .map((field) => field.split("\t").at(-1) ?? "");
  return readRecords(root)
    .filter(
      (fault) =>
        changed.has(fault.patch) ||
        patched(fault).some((path) => changed.has(path)),
    )
    .map(({ id }) => id);
}

export async function replayAll(
  root: string,
  ids: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const faults = readRecords(root);
  const unknown = ids.filter((id) => !faults.some((fault) => fault.id === id));
  if (unknown.length > 0) {
    process.stderr.write(
      `No fault record ${unknown.join(", ")} in ${recordsPath}. Repair: pass an id that file lists.\n`,
    );
    return 2;
  }
  const chosen =
    ids.length === 0 ? faults : faults.filter(({ id }) => ids.includes(id));
  if (chosen.length === 0) {
    print(
      `${recordsPath} has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.`,
    );
    return 1;
  }
  const limitMilliseconds = stepLimitMilliseconds(env);
  const commit = commitWorkingTreeInScratchIndex(root);
  const started = performance.now();
  let killed = 0;
  for (const fault of chosen) {
    const begun = performance.now();
    const verdict = await replay(root, fault, commit, limitMilliseconds);
    haltIfStopped(fault.id);
    report(
      fault,
      verdict,
      (performance.now() - begun) / 1000,
      limitMilliseconds,
    );
    if (verdict.kind === "KILLED") killed += 1;
  }
  const seconds = (performance.now() - started) / 1000;
  print(
    `${killed} of ${chosen.length} planted faults KILLED in ${seconds.toFixed(1)} s, ${(seconds / chosen.length).toFixed(1)} s per fault, with Bun ${Bun.version}.`,
  );
  return killed === chosen.length ? 0 : 1;
}

export function add(root: string, argv: readonly string[]): number {
  const [sha, sourcePath, testFile, title] = argv;
  if (
    sha === undefined ||
    sourcePath === undefined ||
    testFile === undefined ||
    title === undefined
  ) {
    process.stderr.write(
      "Usage: bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
    );
    return 2;
  }
  const full = gitOrThrow(root, [
    "rev-parse",
    "--verify",
    `${sha}^{commit}`,
  ]).trim();
  const short = gitOrThrow(root, ["rev-parse", "--short", full]).trim();
  const subject = gitOrThrow(root, ["log", "-1", "--format=%s", full]).trim();
  const reverse = gitOrThrow(root, [
    "diff",
    full,
    `${full}^`,
    "--",
    sourcePath,
  ]);
  if (reverse === "") {
    process.stderr.write(
      `${short} does not change ${sourcePath}. Repair: pass a path that git diff --name-only ${short}^ ${short} lists.\n`,
    );
    return 2;
  }
  const id = `${short}-${basename(sourcePath).replace(/\.[^.]+$/, "")}`;
  const fault = parseFault(
    {
      id,
      patch: `${patchFolder}/${id}.patch`,
      testFile,
      title,
      source: `${short} ${subject}`,
    },
    "planted-fault:add",
    root,
  );
  const faults = readRecords(root);
  if (faults.some((each) => each.id === id)) {
    process.stderr.write(
      `${recordsPath} already lists ${id}. Repair: plant it again by hand, run git diff -- ${quoted(sourcePath)} > ${quoted(fault.patch)}, then undo the planted edit; or add the new record by hand under another id.\n`,
    );
    return 2;
  }
  mkdirSync(join(root, patchFolder), { recursive: true });
  writeFileSync(join(root, fault.patch), reverse);
  faults.push(fault);
  writeFileSync(
    join(root, recordsPath),
    `${JSON.stringify(faults, null, 2)}\n`,
  );
  print(`Added ${id}. Replay it: bun run fault-replay ${id}`);
  return 0;
}

function replayChangedSince(
  root: string,
  [, base, ...extra]: readonly string[],
): Promise<number> | number {
  if (base === undefined || extra.length > 0) {
    process.stderr.write(
      "Usage: bun run fault-replay --changed-since <base>\n",
    );
    return 2;
  }
  const ids = faultsTouchedSince(root, base);
  if (ids.length > 0) return replayAll(root, ids, process.env);
  const short = gitOrThrow(root, ["rev-parse", "--short", base]).trim();
  print(
    `No planted fault patches a file changed since ${short}, so there is nothing to replay.`,
  );
  return 0;
}

async function main(
  root: string,
  [command, ...rest]: readonly string[],
): Promise<number> {
  if (command === "replay" && rest[0] === "--changed-since")
    return replayChangedSince(root, rest);
  if (command === "replay") return replayAll(root, rest, process.env);
  if (command === "add") return add(root, rest);
  process.stderr.write(
    "Usage: bun run fault-replay [id ...] | bun run fault-replay --changed-since <base> | bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
  );
  return 2;
}

if (import.meta.main) {
  for (const signal of signals)
    process.on(signal, () => {
      active.stoppedBy ??= signal;
      process.exitCode = 128 + constants.signals[active.stoppedBy];
      active.stop?.();
    });

  let code: number;
  try {
    code = await main(join(import.meta.dir, ".."), process.argv.slice(2));
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
}
