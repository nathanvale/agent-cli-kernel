import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { constants, release, type } from "node:os";
import { join, resolve } from "node:path";
import { capabilityQualificationTable } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import type { CapabilityQualificationRow } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { resolveCoordination } from "../../../kernel/src/addons/state/coordination.ts";
import {
  startChild,
  withoutRepositoryLocation,
} from "../../../scripts/process-runner.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  capabilityQualificationCases,
  own,
  parseRecord,
  qualifiedSourceFiles,
  recordFolder,
  recordPath,
  recordSchema,
  requiredCaseIds,
  runEntries,
  sourceHash,
} from "./capability-qualification-record.ts";
import type {
  CapabilityQualificationRecord,
  CapabilityQualificationRun,
  CaseResult,
  PlatformFacts,
  RunEntry,
} from "./capability-qualification-record.ts";
import type { StateCase } from "./cases.ts";

// Interface: `bun run capability-qualification-run <candidate row file>
// <state root parent> [--entry fixture.ts|index.ts]` (journal version 2
// design part 2 section 3). It runs the covered cases of the state case table
// through the state test harness on observed facts only, then adds one
// capability qualification run to the row's record by a temporary file and a
// rename. It refuses, writing nothing, when SX_FACT_OVERRIDES is set or the
// checkout is not clean.

export const runVariable = "SX_CAPABILITY_QUALIFICATION_RUN";
const usage =
  "Usage: bun run capability-qualification-run <candidate row file> <state root parent> [--entry fixture.ts|index.ts]";
const caseRunMilliseconds = 60 * 60_000;
const gitMilliseconds = 30_000;

export type CandidateRow = Pick<
  CapabilityQualificationRow,
  | "id"
  | "os"
  | "majorRelease"
  | "observedRelease"
  | "filesystem"
  | "primitive"
  | "bootIdentitySource"
>;

export type CaseRequest = {
  readonly root: string;
  readonly parent: string;
  readonly entry: RunEntry;
  readonly candidate: CandidateRow;
  readonly selection: readonly StateCase[];
};

export type RunContext = {
  readonly root: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly print: (line: string) => void;
  readonly runCases?: (request: CaseRequest) => Promise<string>;
  readonly beforeRename?: (temporary: string) => void;
};

export type ObservedFacts = Pick<
  CapabilityQualificationRecord,
  "platform" | "filesystem" | "primitive" | "bootIdentitySource"
>;

function text(source: unknown, key: string): string {
  const value = own(source, key);
  if (typeof value !== "string" || value === "")
    throw new Error(`${key} is not text`);
  return value;
}

function candidateRow(source: unknown): CandidateRow {
  const id = text(source, "id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    throw new Error(`id ${id} is not lower-case words joined by hyphens`);
  const filesystem = own(source, "filesystem");
  const fileType = own(filesystem, "type");
  if (typeof fileType !== "number" || !Number.isInteger(fileType))
    throw new Error("filesystem.type is not a whole number");
  return {
    id,
    os: text(source, "os"),
    majorRelease: text(source, "majorRelease"),
    observedRelease: text(source, "observedRelease"),
    filesystem: { name: text(filesystem, "name"), type: fileType },
    primitive: text(source, "primitive"),
    bootIdentitySource: text(source, "bootIdentitySource"),
  };
}

function parseCandidateRow(source: string): CandidateRow {
  return candidateRow(JSON.parse(source));
}

export function runVariableValue(
  entry: RunEntry,
  candidate: CandidateRow,
): string {
  return JSON.stringify({ entry, candidate });
}

export function worldEnvironment(
  value: string | undefined,
  qualification: "fixture" | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  let entry: RunEntry;
  let candidate: CandidateRow;
  try {
    const parsed: unknown = JSON.parse(value);
    const named = own(parsed, "entry");
    const found = runEntries.find((each) => each === named);
    if (found === undefined) throw new Error("its entry is not known");
    entry = found;
    candidate = candidateRow(own(parsed, "candidate"));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${runVariable} is not a capability qualification run: ${why}`,
      { cause: error },
    );
  }
  if (entry === "index.ts") return { SX_ENTRY: "production" };
  if (qualification !== "fixture") return {};
  return {
    SX_CANDIDATE_ROW: JSON.stringify({
      os: candidate.os,
      majorRelease: candidate.majorRelease,
      observedRelease: candidate.observedRelease,
      filesystemName: candidate.filesystem.name,
      filesystemType: candidate.filesystem.type,
      primitive: candidate.primitive,
      bootIdentitySource: candidate.bootIdentitySource,
    }),
  };
}

function executableIds(selection: readonly StateCase[]): readonly string[] {
  return selection
    .filter((row) => row.status === "executable")
    .map((row) => row.id);
}

export function testNamePattern(selection: readonly StateCase[]): string {
  const ids = executableIds(selection).map((id) =>
    id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `^(?:${ids.join("|")})(?: |$)`;
}

type Reported = "passed" | "failed" | "skipped";

function decoded(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function reportedTests(junit: string): ReadonlyMap<string, Reported> {
  const tests = new Map<string, Reported>();
  for (const match of junit.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const name = /\bname="([^"]*)"/.exec(match[1] ?? "")?.[1];
    if (name === undefined) continue;
    const body = match[2] ?? "";
    tests.set(
      decoded(name),
      /<(?:failure|error)\b/.test(body)
        ? "failed"
        : /<skipped\b/.test(body)
          ? "skipped"
          : "passed",
    );
  }
  return tests;
}

export function caseResults(
  junit: string,
  selection: readonly StateCase[],
): readonly CaseResult[] {
  const tests = reportedTests(junit);
  return selection.map((row): CaseResult => {
    if (row.status === "pending")
      return {
        id: row.id,
        result: "unproved",
        detail: `pending: ${row.reason}`,
      };
    const exact = tests.get(row.id);
    if (exact === "passed")
      return { id: row.id, result: "pass", detail: "passed" };
    if (exact === "skipped")
      return { id: row.id, result: "fail", detail: "skipped" };
    const failed = {
      id: row.id,
      result: "fail",
      detail: "failed; the run's output shows why",
    } as const;
    if (exact === "failed") return failed;
    const control = [...tests].find(([name]) =>
      name.startsWith(`${row.id} UNPROVED`),
    );
    if (control === undefined)
      return {
        id: row.id,
        result: "fail",
        detail: "no test ran for this case",
      };
    return control[1] === "passed"
      ? {
          id: row.id,
          result: "unproved",
          detail: control[0].slice(row.id.length + 1),
        }
      : failed;
  });
}

function differing(
  checks: readonly (readonly [string, unknown, unknown])[],
): readonly string[] {
  return checks
    .filter(([, left, right]) => left !== right)
    .map(([name]) => name);
}

export function secondRunProblem(
  table: readonly CapabilityQualificationRow[],
  candidate: CandidateRow,
  existing: CapabilityQualificationRecord | undefined,
  observed: ObservedFacts,
): string | undefined {
  const row = table.find((entry) => entry.id === candidate.id);
  if (row === undefined)
    return `row ${candidate.id} is not in the capability qualification table`;
  const rowDiffers = differing([
    ["os", row.os, candidate.os],
    ["majorRelease", row.majorRelease, candidate.majorRelease],
    ["observedRelease", row.observedRelease, candidate.observedRelease],
    ["filesystem", row.filesystem.type, candidate.filesystem.type],
    ["primitive", row.primitive, candidate.primitive],
    [
      "bootIdentitySource",
      row.bootIdentitySource,
      candidate.bootIdentitySource,
    ],
  ]);
  if (rowDiffers.length > 0)
    return `row ${candidate.id} in the capability qualification table differs from the candidate row in ${rowDiffers.join(", ")}`;
  if (existing === undefined)
    return `no capability qualification record at ${recordPath(candidate.id)} from a fixture.ts run`;
  const entries = existing.runs.map((run) => run.entry);
  if (entries.join(",") !== "fixture.ts")
    return `the record holds runs [${entries.join(", ")}]; the index.ts run follows exactly one fixture.ts run`;
  const platformDiffers = differing([
    ["os", existing.platform.os, observed.platform.os],
    [
      "majorRelease",
      existing.platform.majorRelease,
      observed.platform.majorRelease,
    ],
    ["filesystem", existing.filesystem.type, observed.filesystem.type],
    ["primitive", existing.primitive, observed.primitive],
    [
      "bootIdentitySource",
      existing.bootIdentitySource.source,
      observed.bootIdentitySource.source,
    ],
  ]);
  return platformDiffers.length > 0
    ? `this platform differs from the record's in ${platformDiffers.join(", ")}`
    : undefined;
}

function readable(path: string): boolean {
  try {
    return readFileSync(path, "utf8").trim() !== "";
  } catch {
    return false;
  }
}

function distribution(): string {
  try {
    const found = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(
      readFileSync("/etc/os-release", "utf8"),
    )?.[1];
    if (found !== undefined && found !== "") return found;
  } catch {
    return type();
  }
  return type();
}

function cLibrary(): string {
  if (process.platform !== "linux") return "not read off Linux";
  const header = own(process.report.getReport(), "header");
  const glibc = own(header, "glibcVersionRuntime");
  if (typeof glibc === "string" && glibc !== "") return `glibc ${glibc}`;
  try {
    if (readdirSync("/lib").some((name) => name.startsWith("ld-musl-")))
      return "musl";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function observedPlatform(): PlatformFacts {
  const observed = release();
  return {
    os: process.platform,
    release: observed,
    majorRelease: observed.split(".")[0] ?? observed,
    architecture: process.arch,
    runtime: `bun ${Bun.version}`,
    distribution: distribution(),
    cLibrary: cLibrary(),
    container: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
  };
}

function observedFacts(parent: string, candidate: CandidateRow): ObservedFacts {
  const route = resolveCoordination();
  return {
    platform: observedPlatform(),
    filesystem: { type: statfsSync(parent).type },
    primitive: route.available ? route.route : "no coordination route",
    bootIdentitySource: {
      source: candidate.bootIdentitySource,
      readable: readable(candidate.bootIdentitySource),
    },
  };
}

function git(root: string, args: readonly string[]): string {
  const result = Bun.spawnSync(
    ["git", "-C", root, "-c", "core.quotepath=off", ...args],
    {
      env: withoutRepositoryLocation(process.env),
      stdout: "pipe",
      stderr: "pipe",
      timeout: gitMilliseconds,
      killSignal: "SIGKILL",
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString();
}

function overriddenFacts(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    const facts = ["release", "filesystem", "bootIdentity", "devices"].filter(
      (fact) => own(parsed, fact) !== undefined,
    );
    return facts.length > 0 ? facts.join(", ") : "no known fact";
  } catch {
    return "unreadable";
  }
}

type Prepared = {
  readonly candidate: CandidateRow;
  readonly parent: string;
  readonly entry: RunEntry;
  readonly existing: CapabilityQualificationRecord | undefined;
};

function readCandidate(file: string): CandidateRow | string {
  try {
    return parseCandidateRow(readFileSync(file, "utf8"));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `Refused: the candidate row ${file} is unreadable (${why}). Repair: give a JSON file with the row's id, os, majorRelease, observedRelease, filesystem, primitive and bootIdentitySource, then rerun.`;
  }
}

function cleanProblem(root: string): string | undefined {
  const changed = git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
    .split("\n")
    .filter(Boolean);
  if (changed.length === 0) return undefined;
  const shown = changed.slice(0, 5).join("; ");
  const more =
    changed.length > 5 ? ` and ${String(changed.length - 5)} more` : "";
  return `Refused: the checkout is not clean (${shown}${more}); a capability qualification run records the commit it ran. Repair: commit or remove those changes, then rerun.`;
}

function existingRecord(
  root: string,
  id: string,
): CapabilityQualificationRecord | undefined | string {
  const path = join(root, recordPath(id));
  if (!existsSync(path)) return undefined;
  try {
    return parseRecord(readFileSync(path, "utf8"));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `${recordPath(id)} is not a capability qualification record (${why})`;
  }
}

function parseArguments(argv: readonly string[]):
  | {
      readonly rowFile: string;
      readonly parentFolder: string;
      readonly entry: RunEntry;
    }
  | undefined {
  const [rowFile, parentFolder, flag, named, ...rest] = argv;
  const entry =
    flag === undefined
      ? "fixture.ts"
      : runEntries.find((each) => flag === "--entry" && each === named);
  return rowFile === undefined ||
    parentFolder === undefined ||
    entry === undefined ||
    rest.length > 0
    ? undefined
    : { rowFile, parentFolder, entry };
}

function secondRunRefusal(
  root: string,
  parent: string,
  candidate: CandidateRow,
): CapabilityQualificationRecord | string {
  const existing = existingRecord(root, candidate.id);
  const problem =
    typeof existing === "string"
      ? existing
      : secondRunProblem(
          capabilityQualificationTable,
          candidate,
          existing,
          observedFacts(parent, candidate),
        );
  if (problem === undefined && typeof existing === "object") return existing;
  return `Refused: ${problem ?? "no record"}. Repair: on the row's own branch, commit the row and its record from one fixture.ts run on this platform, then rerun.`;
}

function prepare(
  argv: readonly string[],
  context: RunContext,
): Prepared | string {
  const parsed = parseArguments(argv);
  if (parsed === undefined) return usage;
  const overrides = context.environment.SX_FACT_OVERRIDES;
  if (overrides !== undefined)
    return `Refused: SX_FACT_OVERRIDES is set (${overriddenFacts(overrides)}); a capability qualification record holds observed facts only. Repair: unset SX_FACT_OVERRIDES, then rerun.`;
  const candidate = readCandidate(resolve(parsed.rowFile));
  if (typeof candidate === "string") return candidate;
  const parent = resolve(parsed.parentFolder);
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    return `Refused: the state root parent ${parent} is not a folder. Repair: create it on the filesystem under test, then rerun.`;
  const dirty = cleanProblem(context.root);
  if (dirty !== undefined) return dirty;
  const { entry } = parsed;
  if (entry === "fixture.ts")
    return existsSync(join(context.root, recordPath(candidate.id)))
      ? `Refused: ${recordPath(candidate.id)} exists; a fixture.ts run starts a new capability qualification record. Repair: remove it and commit that, then rerun.`
      : { candidate, parent, entry, existing: undefined };
  const existing = secondRunRefusal(context.root, parent, candidate);
  return typeof existing === "string"
    ? existing
    : { candidate, parent, entry, existing };
}

function writeRecord(
  root: string,
  record: CapabilityQualificationRecord,
  beforeRename: ((temporary: string) => void) | undefined,
): void {
  mkdirSync(join(root, recordFolder), { recursive: true });
  const final = join(root, recordPath(record.row));
  const temporary = `${final}.partial`;
  const descriptor = openSync(temporary, "w", 0o644);
  try {
    writeSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  beforeRename?.(temporary);
  renameSync(temporary, final);
}

const active: { stop?: () => void } = {};

async function bunTest(request: CaseRequest): Promise<string> {
  const report = join(
    testFolder("c3-capability-qualification-run-"),
    "report.xml",
  );
  const child = startChild(
    [
      process.execPath,
      "test",
      "./tests/kernel/state",
      "--test-name-pattern",
      testNamePattern(request.selection),
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    {
      cwd: request.root,
      env: {
        ...withoutRepositoryLocation(process.env),
        STATE_TEST_DIR: request.parent,
        [runVariable]: runVariableValue(request.entry, request.candidate),
      },
      limitMilliseconds: caseRunMilliseconds,
    },
  );
  active.stop = child.stop;
  const finished = await child.finished;
  delete active.stop;
  process.stderr.write(finished.stdout + finished.stderr);
  if (finished.timedOut)
    throw new Error(
      `the case run outlived its ${String(caseRunMilliseconds / 60_000)} minute limit`,
    );
  if (!existsSync(report)) throw new Error("the case run wrote no report");
  return readFileSync(report, "utf8");
}

export async function capabilityQualificationRun(
  argv: readonly string[],
  context: RunContext,
): Promise<number> {
  const prepared = prepare(argv, context);
  if (typeof prepared === "string") {
    context.print(prepared);
    return prepared === usage ? 2 : 1;
  }
  const { candidate, parent, entry, existing } = prepared;
  const selection = capabilityQualificationCases();
  const observed = observedFacts(parent, candidate);
  const commit = git(context.root, ["rev-parse", "HEAD"]).trim();
  const hash = sourceHash(qualifiedSourceFiles(context.root));
  const started = new Date().toISOString();
  let report: string;
  try {
    report = await (context.runCases ?? bunTest)({
      root: context.root,
      parent,
      entry,
      candidate,
      selection,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    context.print(
      `Refused: the case run ended without results (${why}); no capability qualification record is written. Repair: read the run's output above, then rerun.`,
    );
    return 1;
  }
  const cases = caseResults(report, selection);
  const run: CapabilityQualificationRun = {
    entry,
    commit,
    sourceHash: hash,
    started,
    ended: new Date().toISOString(),
    cases,
  };
  const record: CapabilityQualificationRecord =
    existing === undefined
      ? {
          schema: recordSchema,
          row: candidate.id,
          factSource: "observed",
          ...observed,
          runs: [run],
        }
      : { ...existing, runs: [...existing.runs, run] };
  writeRecord(context.root, record, context.beforeRename);
  const count = (result: CaseResult["result"]) =>
    String(cases.filter((entry) => entry.result === result).length);
  context.print(
    `Wrote ${recordPath(candidate.id)}: ${count("pass")} pass, ${count("fail")} fail, ${count("unproved")} unproved.`,
  );
  const required = requiredCaseIds(selection);
  const short = cases.filter(
    (entry) => required.includes(entry.id) && entry.result !== "pass",
  );
  if (short.length === 0) return 0;
  context.print(
    `The ${entry} run does not qualify row ${candidate.id}: ${short.map((entry) => `${entry.id} ${entry.result}`).join(", ")}.`,
  );
  return 1;
}

if (import.meta.main) {
  let stoppedBy: number | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      stoppedBy ??= 128 + constants.signals[signal];
      active.stop?.();
    });
  const code = await capabilityQualificationRun(process.argv.slice(2), {
    root: join(import.meta.dir, "..", "..", ".."),
    environment: process.env,
    print: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = stoppedBy ?? code;
}
