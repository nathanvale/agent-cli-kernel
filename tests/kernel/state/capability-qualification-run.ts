import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { constants, release, type } from "node:os";
import { join, resolve } from "node:path";
import { capabilityQualificationTable } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import type { CapabilityQualificationRow } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import {
  bootIdentitySource,
  majorReleaseOf,
} from "../../../kernel/src/addons/state/qualification.ts";
import type { FactOverrides } from "../../../kernel/src/addons/state/qualification.ts";
import { resolveCoordination } from "../../../kernel/src/addons/state/coordination.ts";
import {
  startChild,
  withoutRepositoryLocation,
} from "../../../scripts/process-runner.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  capabilityQualificationCases,
  messageOf,
  own,
  parseRecord,
  qualifiedPaths,
  qualifiedSourceFiles,
  recordFolder,
  recordPath,
  recordSchema,
  registeredCases,
  otherEntryOnly,
  requiredCaseIds,
  runEntries,
  runsThrough,
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
// rename. It refuses, writing nothing, when SX_FACT_OVERRIDES is set, the
// checkout is not clean, or a qualified source file is ignored by git. A test
// world in a run refuses a fact override or candidate row of its own.

export const runVariable = "SX_CAPABILITY_QUALIFICATION_RUN";
const usage =
  "Usage: bun run capability-qualification-run <candidate row file> <state root parent> [--entry fixture.ts|index.ts]";
const caseRunMilliseconds = 60 * 60_000;
const gitMilliseconds = 10_000;

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

export type Environment = Readonly<Record<string, string | undefined>>;

export type CaseRequest = {
  readonly root: string;
  readonly parent: string;
  readonly entry: RunEntry;
  readonly candidate: CandidateRow;
  readonly selection: readonly StateCase[];
  readonly environment: Environment;
  readonly output: (text: string) => void;
};

export type CaseRun = { readonly report: string; readonly exitCode: number };

export type RunContext = {
  readonly root: string;
  readonly cwd: string;
  readonly environment: Environment;
  readonly print: (line: string) => void;
  readonly output?: (text: string) => void;
  readonly runCases?: (request: CaseRequest) => Promise<CaseRun>;
  readonly gitMilliseconds?: number;
  readonly table?: readonly CapabilityQualificationRow[];
  readonly stopped?: () => boolean;
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

export function runVariableValue(
  entry: RunEntry,
  candidate: CandidateRow,
): string {
  return JSON.stringify({ entry, candidate });
}

export function runOf(
  value: string | undefined,
): { readonly entry: RunEntry; readonly candidate: CandidateRow } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const named = own(parsed, "entry");
    const entry = runEntries.find((each) => each === named);
    if (entry === undefined) throw new Error("its entry is not known");
    return { entry, candidate: candidateRow(own(parsed, "candidate")) };
  } catch (error) {
    throw new Error(
      `${runVariable} is not a capability qualification run: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

export function worldEnvironment(
  value: string | undefined,
  qualification: "fixture" | undefined,
): Readonly<Record<string, string>> | undefined {
  const run = runOf(value);
  if (run === undefined) return undefined;
  const { entry, candidate } = run;
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

const runOwnedVariables = [
  "SX_FACT_OVERRIDES",
  "SX_CANDIDATE_ROW",
  "SX_QUALIFICATION",
];

export function refuseRunOverrides(extra: Readonly<Record<string, string>>) {
  const taken = runOwnedVariables.filter((name) => Object.hasOwn(extra, name));
  if (taken.length > 0)
    throw new Error(
      `A capability qualification run sets no ${taken.join(", ")} for one test: every world runs on observed facts and the candidate row.`,
    );
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

function reportedList(junit: string): readonly (readonly [string, Reported])[] {
  return [
    ...junit.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
  ].flatMap((match) => {
    const name = /\bname="([^"]*)"/.exec(match[1] ?? "")?.[1];
    if (name === undefined) return [];
    const body = match[2] ?? "";
    const reported: Reported = /<(?:failure|error)\b/.test(body)
      ? "failed"
      : /<skipped\b/.test(body)
        ? "skipped"
        : "passed";
    return [[decoded(name), reported] as const];
  });
}

function reportedTests(junit: string): ReadonlyMap<string, Reported> {
  return new Map(reportedList(junit));
}

function reportedTwice(junit: string): readonly string[] {
  const names = reportedList(junit).map(([name]) => name);
  return [
    ...new Set(names.filter((name, index) => names.indexOf(name) !== index)),
  ];
}

export function caseResults(
  junit: string,
  selection: readonly StateCase[],
  entry: RunEntry,
): readonly CaseResult[] {
  const tests = reportedTests(junit);
  return selection.map((row): CaseResult => {
    if (row.status === "pending")
      return {
        id: row.id,
        result: "unproved",
        detail: `pending: ${row.reason}`,
      };
    const only = otherEntryOnly(row, entry);
    if (only !== undefined)
      return { id: row.id, result: "not-runnable", reason: only.reason };
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

export function distributionOf(
  osRelease: string | undefined,
  fallback: string,
): string {
  const field = (name: string) =>
    (osRelease === undefined
      ? undefined
      : new RegExp(`^${name}="?([^"\\n]*)"?$`, "m").exec(osRelease)?.[1]
    )
      ?.replace(/[^A-Za-z0-9._-]/g, "")
      .slice(0, 32) ?? "";
  const id = field("ID");
  if (id === "") return fallback;
  const version = field("VERSION_ID");
  return version === "" ? id : `${id} ${version}`;
}

function distribution(): string {
  try {
    return distributionOf(readFileSync("/etc/os-release", "utf8"), type());
  } catch {
    return type();
  }
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
    majorRelease: majorReleaseOf(observed),
    architecture: process.arch,
    runtime: `bun ${Bun.version}`,
    distribution: distribution(),
    cLibrary: cLibrary(),
    container: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
  };
}

function observedFacts(parent: string): ObservedFacts {
  const route = resolveCoordination();
  return {
    platform: observedPlatform(),
    filesystem: { type: statfsSync(parent).type },
    primitive: route.available ? route.route : "no coordination route",
    bootIdentitySource: {
      source: bootIdentitySource,
      readable: readable(bootIdentitySource),
    },
  };
}

type GitPlace = Pick<RunContext, "root" | "environment" | "gitMilliseconds">;

function gitBytes(place: GitPlace, args: readonly string[]): Buffer {
  const bound = place.gitMilliseconds ?? gitMilliseconds;
  const result = Bun.spawnSync(
    ["git", "-C", place.root, "-c", "core.quotepath=off", ...args],
    {
      env: withoutRepositoryLocation(place.environment),
      stdout: "pipe",
      stderr: "pipe",
      timeout: bound,
      killSignal: "SIGKILL",
    },
  );
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${args.join(" ")} did not finish within ${String(bound)} ms`,
    );
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout;
}

function git(place: GitPlace, args: readonly string[]): string {
  return gitBytes(place, args).toString();
}

function nulSeparated(place: GitPlace, args: readonly string[]): string[] {
  return git(place, args).split("\0").filter(Boolean);
}

const committedBytesOnly =
  "a capability qualification run reads committed bytes only.";

function hiddenProblem(place: GitPlace): string | undefined {
  const hidden = nulSeparated(place, ["ls-files", "-v", "-z"]).flatMap(
    (line) => {
      const tag = line.slice(0, 1);
      const path = line.slice(2);
      return [
        ...(tag !== tag.toUpperCase() ? [`assume-unchanged ${path}`] : []),
        ...(tag.toUpperCase() === "S" ? [`skip-worktree ${path}`] : []),
      ];
    },
  );
  return hidden.length === 0
    ? undefined
    : `Refused: git hides changes to tracked files (${hidden.join("; ")}); ${committedBytesOnly} Repair: clear the flag with git update-index --no-assume-unchanged or --no-skip-worktree, then rerun.`;
}

function workingBytes(path: string, mode: string): Buffer | string {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return "missing";
  }
  if (mode === "120000")
    return stats.isSymbolicLink()
      ? Buffer.from(readlinkSync(path))
      : "not a link";
  if (mode === "100644" || mode === "100755")
    return stats.isFile() ? readFileSync(path) : "not a file";
  return `mode ${mode} is not checked`;
}

function committedProblem(place: GitPlace): string | undefined {
  const format = git(place, ["rev-parse", "--show-object-format"]).trim();
  const algorithm = format === "sha256" ? "sha256" : "sha1";
  const differs = nulSeparated(place, ["ls-tree", "-r", "-z", "HEAD"]).flatMap(
    (line) => {
      const tab = line.indexOf("\t");
      const [mode = "", , id = ""] = line.slice(0, tab).split(" ");
      const path = line.slice(tab + 1);
      const bytes = workingBytes(join(place.root, path), mode);
      if (typeof bytes === "string") return [`${path} (${bytes})`];
      const local = createHash(algorithm)
        .update(`blob ${String(bytes.byteLength)}\0`)
        .update(bytes)
        .digest("hex");
      return local === id ? [] : [path];
    },
  );
  return differs.length === 0
    ? undefined
    : `Refused: tracked files differ from their committed bytes (${differs.join("; ")}); ${committedBytesOnly} Repair: restore or commit them, then rerun.`;
}

const factNames = Object.keys({
  release: true,
  filesystem: true,
  bootIdentity: true,
  devices: true,
} satisfies Record<keyof FactOverrides, true>);

function overriddenFacts(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    const facts = factNames.filter((fact) => own(parsed, fact) !== undefined);
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
    return candidateRow(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    return `Refused: the candidate row ${file} is unreadable (${messageOf(error)}). Repair: give a JSON file with the row's id, os, majorRelease, observedRelease, filesystem, primitive and bootIdentitySource, then rerun.`;
  }
}

function cleanProblem(place: GitPlace): string | undefined {
  const fromGit = hiddenProblem(place) ?? committedProblem(place);
  if (fromGit !== undefined) return fromGit;
  const lines = (args: readonly string[]) =>
    git(place, ["status", "--porcelain=v1", ...args])
      .split("\n")
      .filter(Boolean);
  const changed = lines(["--untracked-files=all"]);
  if (changed.length > 0)
    return `Refused: the checkout is not clean (${changed.join("; ")}); a capability qualification run records the commit it ran. Repair: commit or remove those changes, then rerun.`;
  const ignored = lines([
    "--ignored=matching",
    "--untracked-files=all",
    "--",
    ...qualifiedPaths,
  ]);
  return ignored.length === 0
    ? undefined
    : `Refused: git ignores qualified source (${ignored.join("; ")}); sourceHash covers committed bytes only. Repair: remove those files, then rerun.`;
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
    return `${recordPath(id)} is not a capability qualification record (${messageOf(error)})`;
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
  context: RunContext,
  parent: string,
  candidate: CandidateRow,
): CapabilityQualificationRecord | string {
  const existing = existingRecord(context.root, candidate.id);
  const problem =
    typeof existing === "string"
      ? existing
      : secondRunProblem(
          context.table ?? capabilityQualificationTable,
          candidate,
          existing,
          observedFacts(parent),
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
  const candidate = readCandidate(resolve(context.cwd, parsed.rowFile));
  if (typeof candidate === "string") return candidate;
  const parent = resolve(context.cwd, parsed.parentFolder);
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    return `Refused: the state root parent ${parent} is not a folder. Repair: create it on the filesystem under test, then rerun.`;
  const dirty = cleanProblem(context);
  if (dirty !== undefined) return dirty;
  const { entry } = parsed;
  if (entry === "fixture.ts")
    return existsSync(join(context.root, recordPath(candidate.id)))
      ? `Refused: ${recordPath(candidate.id)} exists; a fixture.ts run starts a new capability qualification record. Repair: remove it and commit that, then rerun.`
      : { candidate, parent, entry, existing: undefined };
  const existing = secondRunRefusal(context, parent, candidate);
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

const caseRun: { stop?: () => void } = {};

const readTheRunOutput = "read the run's output above, then rerun";

class CaseRunFailure extends Error {
  constructor(
    message: string,
    readonly repair = readTheRunOutput,
  ) {
    super(message);
  }
}
const stateTests = "tests/kernel/state";

export function caseFiles(
  root: string,
  selection: readonly StateCase[],
): readonly string[] {
  const covered = executableIds(selection);
  return readdirSync(join(root, stateTests))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => `${stateTests}/${name}`)
    .filter((path) =>
      registeredCases(readFileSync(join(root, path), "utf8")).some((id) =>
        covered.includes(id),
      ),
    );
}

export async function runCasesWithBun(
  request: CaseRequest,
  limitMilliseconds = caseRunMilliseconds,
): Promise<CaseRun> {
  const runnable = request.selection.filter((row) =>
    runsThrough(row, request.entry),
  );
  const files = caseFiles(request.root, runnable);
  if (files.length === 0)
    throw new CaseRunFailure(
      `no file in ${stateTests} registers a covered case`,
      `register each covered case with caseTest in ${stateTests}, then rerun`,
    );
  const folder = testFolder(".capability-qualification-run-", request.parent);
  try {
    const report = join(folder, "report.xml");
    const child = startChild(
      [
        process.execPath,
        "test",
        ...files.map((path) => `./${path}`),
        "--test-name-pattern",
        testNamePattern(runnable),
        "--reporter=junit",
        `--reporter-outfile=${report}`,
      ],
      {
        cwd: request.root,
        env: {
          ...withoutRepositoryLocation(request.environment),
          STATE_TEST_DIR: request.parent,
          [runVariable]: runVariableValue(request.entry, request.candidate),
        },
        limitMilliseconds,
      },
    );
    caseRun.stop = child.stop;
    const finished = await child.finished;
    delete caseRun.stop;
    request.output(finished.stdout + finished.stderr);
    if (finished.timedOut)
      throw new CaseRunFailure(
        `the case run outlived its ${String(limitMilliseconds)} ms limit`,
      );
    if (!existsSync(report))
      throw new CaseRunFailure("the case run wrote no report");
    return {
      report: readFileSync(report, "utf8"),
      exitCode: finished.exitCode,
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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
  const observed = observedFacts(parent);
  const commit = git(context, ["rev-parse", "HEAD"]).trim();
  const hash = sourceHash(qualifiedSourceFiles(context.root));
  const started = new Date().toISOString();
  let caseRunResult: CaseRun;
  try {
    caseRunResult = await (context.runCases ?? runCasesWithBun)({
      root: context.root,
      parent,
      entry,
      candidate,
      selection,
      environment: context.environment,
      output: context.output ?? ((text) => process.stderr.write(text)),
    });
  } catch (error) {
    context.print(
      `Refused: the case run ended without results (${messageOf(error)}); no capability qualification record is written. Repair: ${error instanceof CaseRunFailure ? error.repair : readTheRunOutput}.`,
    );
    return 1;
  }
  if (context.stopped?.() === true) {
    context.print(
      "Stopped: the run was asked to stop, so no capability qualification record is written.",
    );
    return 1;
  }
  if (caseRunResult.exitCode !== 0) {
    context.print(
      `Refused: the case run's test process exited ${String(caseRunResult.exitCode)}; a capability qualification record is written only for a run whose test process passed. Repair: ${readTheRunOutput}.`,
    );
    return 1;
  }
  const twice = reportedTwice(caseRunResult.report);
  if (twice.length > 0) {
    context.print(
      `Refused: Bun reported ${twice.join(", ")} twice; no capability qualification record is written. Repair: give each covered case one test, then rerun.`,
    );
    return 1;
  }
  const cases = caseResults(caseRunResult.report, selection, entry);
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
    `Wrote ${recordPath(candidate.id)}: ${count("pass")} pass, ${count("fail")} fail, ${count("unproved")} unproved, ${count("not-runnable")} not-runnable.`,
  );
  const required = requiredCaseIds(entry, selection);
  const notPassed = cases.filter(
    (entry) => required.includes(entry.id) && entry.result !== "pass",
  );
  if (notPassed.length === 0) return 0;
  context.print(
    `The ${entry} run does not qualify row ${candidate.id}: ${notPassed.map((entry) => `${entry.id} ${entry.result}`).join(", ")}.`,
  );
  return 1;
}

if (import.meta.main) {
  let stoppedBy: number | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      stoppedBy ??= 128 + constants.signals[signal];
      caseRun.stop?.();
    });
  try {
    const code = await capabilityQualificationRun(process.argv.slice(2), {
      root: join(import.meta.dir, "..", "..", ".."),
      cwd: process.cwd(),
      environment: process.env,
      print: (line) => process.stdout.write(`${line}\n`),
      stopped: () => stoppedBy !== undefined,
    });
    process.exitCode = stoppedBy ?? code;
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    process.exitCode = stoppedBy ?? 2;
  }
}
