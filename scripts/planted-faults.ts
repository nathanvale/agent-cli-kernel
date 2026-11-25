import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, join } from "node:path";
import {
  type Copy,
  copyCommit,
  copyWorkingTree,
  replayInCopy,
} from "./planted-fault-copy.ts";
import {
  hunksOf,
  patchText,
  place,
  quoted,
  replantRepair,
  type Source,
} from "./planted-fault-patch.ts";
import { recordFiles, type RecordEntry } from "./planted-fault-folders.ts";
import { faultsInShard } from "./planted-fault-shards.ts";
import { type Verdict } from "./planted-fault-verdict.ts";
import {
  runWithOwnTools,
  withoutRepositoryLocation,
} from "./process-runner.ts";

export type { Verdict };

export const recordsPath = "tests/planted-faults/fault-records";
const patchFolder = "tests/planted-faults/patches";
const recordExtension = ".json";

export function recordFile(id: string): string {
  return `${recordsPath}/${id}${recordExtension}`;
}

export type Fault = {
  id: string;
  patch: string;
  testFile: string;
  title: string;
  source: string;
};

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const active: { stop?: () => void; stoppedBy?: (typeof signals)[number] } = {};
const stepLimitVariable = "FAULT_REPLAY_STEP_SECONDS";
const defaultStepLimitSeconds = 300;
const gitMilliseconds = 4_000;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function git(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...withoutRepositoryLocation(process.env), ...extra },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${args.join(" ")} did not finish within ${gitMilliseconds / 1000} s. Repair: run it by hand in ${root} to see where it waits, then run this command again.`,
    );
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function gitOrThrow(
  root: string,
  args: readonly string[],
  extra?: Readonly<Record<string, string>>,
): string {
  const result = git(root, args, extra);
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

export function recordEntries(root: string): RecordEntry[] {
  return recordFiles(root, recordsPath);
}

export function readRecords(root: string): Fault[] {
  return recordEntries(root).map(({ file, entry }) =>
    parseFault(entry, file, root),
  );
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
  haltIfStopped(id);
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

function sourceAt(root: string, base: string): Source {
  return {
    read: (path) => {
      const shown = git(root, ["cat-file", "blob", `${base}:${path}`]);
      return shown.ok ? shown.stdout : undefined;
    },
    holding: (line) => {
      const found = git(root, ["grep", "-l", "-z", "-F", "-e", line, base]);
      if (found.exitCode === 1) return [];
      if (!found.ok)
        throw new Error(
          `git grep -l -F -e ${quoted(line)} ${base} failed: ${found.stderr.trim()}. Repair: run it by hand in ${root} to see why, then run this command again.`,
        );
      return found.stdout
        .split("\0")
        .filter((path) => path !== "")
        .map((path) => path.slice(base.length + 1));
    },
  };
}

export async function replay(
  root: string,
  fault: Fault,
  commit: string,
  limitMilliseconds: number,
): Promise<Verdict> {
  const patch = patchText(root, fault);
  let copy: Copy | undefined;
  try {
    copy = await copyCommit(root, commit, fault.id, limitMilliseconds, step);
    return await replayInCopy(copy, fault, patch, limitMilliseconds, step);
  } catch (error) {
    if (error instanceof StepTimedOut)
      return { kind: "TIMEOUT", step: error.step };
    throw error;
  } finally {
    if (copy !== undefined)
      rmSync(copy.folder, { recursive: true, force: true });
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
        `KILLED ${fault.id} ${took}. Failed: ${verdict.failing.join(" | ")}`,
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
      print(replantRepair(fault));
      return;
    case "UNPARSED":
      print(
        `UNPARSED ${fault.id} ${took}. ${verdict.files.join(", ")} failed to parse with ${fault.patch} applied, so any test would fail for the wrong reason.`,
      );
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(`Repair: re-plant the fault so the patched file parses. ${done}`);
      return;
    case "UNMATCHED": {
      const failed =
        verdict.failing.join(" | ") || "the test file, which did not load";
      print(
        `UNMATCHED ${fault.id} ${took}. ${shown} failed, but no failing test matched ${quoted(fault.title)}. Failed: ${failed}.`,
      );
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(
        `Repair: re-plant the fault so a test matching ${quoted(fault.title)} fails, or update the record's title. ${done}`,
      );
      return;
    }
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
    gitOrThrow(root, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      base,
      "HEAD",
    ])
      .split("\0")
      .filter((path) => path !== ""),
  );
  const recordChanged = (fault: Fault): boolean =>
    changed.has(recordFile(fault.id));
  const atBase = sourceAt(root, base);
  const patched = (fault: Fault): string[] => {
    const text = patchText(root, fault);
    const placement = place(fault.patch, text, atBase);
    return [
      ...hunksOf(text).map(({ path }) => path),
      ...(placement.kind === "placed"
        ? placement.files.keys()
        : placement.candidates),
    ];
  };
  return readRecords(root)
    .filter(
      (fault) =>
        recordChanged(fault) ||
        changed.has(fault.patch) ||
        changed.has(fault.testFile) ||
        patched(fault).some((path) => changed.has(path)),
    )
    .map(({ id }) => id);
}

function printSummary(killed: number, total: number, started: number): void {
  const seconds = (performance.now() - started) / 1000;
  print(
    `${killed} of ${total} planted faults KILLED in ${seconds.toFixed(1)} s, ${(seconds / total).toFixed(1)} s per fault, with Bun ${Bun.version}.`,
  );
}

async function replayOne(
  root: string,
  copy: Copy,
  fault: Fault,
  limitMilliseconds: number,
): Promise<Verdict> {
  try {
    return await replayInCopy(
      copy,
      fault,
      patchText(root, fault),
      limitMilliseconds,
      step,
    );
  } catch (error) {
    if (error instanceof StepTimedOut)
      return { kind: "TIMEOUT", step: error.step };
    throw error;
  }
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
      `No fault record ${unknown.join(", ")} in ${recordsPath}. Repair: pass an id that folder holds.\n`,
    );
    return 2;
  }
  const chosen =
    ids.length === 0 ? faults : faults.filter(({ id }) => ids.includes(id));
  const [first] = chosen;
  if (first === undefined) {
    print(
      `${recordsPath} has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.`,
    );
    return 1;
  }
  const limitMilliseconds = stepLimitMilliseconds(env);
  const started = performance.now();
  let killed = 0;
  let copy: Copy | undefined;
  try {
    try {
      copy = await copyWorkingTree(root, first.id, limitMilliseconds, step);
    } catch (error) {
      if (error instanceof StepTimedOut) {
        const seconds = (performance.now() - started) / 1000;
        for (const fault of chosen)
          report(
            fault,
            { kind: "TIMEOUT", step: error.step },
            seconds,
            limitMilliseconds,
          );
        printSummary(0, chosen.length, started);
        return 1;
      }
      throw error;
    }
    for (const fault of chosen) {
      haltIfStopped(fault.id);
      const begun = performance.now();
      const verdict = await replayOne(root, copy, fault, limitMilliseconds);
      haltIfStopped(fault.id);
      report(
        fault,
        verdict,
        (performance.now() - begun) / 1000,
        limitMilliseconds,
      );
      if (verdict.kind === "KILLED") killed += 1;
    }
  } finally {
    if (copy !== undefined)
      rmSync(copy.folder, { recursive: true, force: true });
  }
  printSummary(killed, chosen.length, started);
  return killed === chosen.length ? 0 : 1;
}

function createdNew(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { flag: "wx" });
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "EEXIST") return false;
    throw error;
  }
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
  const caseTwin = readRecords(root).find(
    (each) => each.id !== id && each.id.toLowerCase() === id.toLowerCase(),
  );
  if (caseTwin !== undefined) {
    process.stderr.write(
      `${recordsPath} already holds ${caseTwin.id}, which differs from ${id} only by letter case, and a macOS folder holds one file for both. Repair: add the new record by hand under an id that differs by more than case.\n`,
    );
    return 2;
  }
  mkdirSync(join(root, recordsPath), { recursive: true });
  if (
    !createdNew(
      join(root, recordFile(id)),
      `${JSON.stringify(fault, null, 2)}\n`,
    )
  ) {
    process.stderr.write(
      `${recordsPath} already holds ${id}. Repair: plant it again by hand, run git diff -- ${quoted(sourcePath)} > ${quoted(fault.patch)}, then undo the planted edit; or add the new record by hand under another id.\n`,
    );
    return 2;
  }
  mkdirSync(join(root, patchFolder), { recursive: true });
  if (!createdNew(join(root, fault.patch), reverse)) {
    rmSync(join(root, recordFile(id)));
    process.stderr.write(
      `${fault.patch} already exists, and no record names it. Repair: delete or rename that patch if nothing uses it, then run this command again.\n`,
    );
    return 2;
  }
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
  if (readRecords(root).length === 0) return replayAll(root, [], process.env);
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
  if (command === "replay" && rest[0] === "--shard")
    return replayAll(
      root,
      faultsInShard(root, rest, readRecords, faultsTouchedSince),
      process.env,
    );
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
