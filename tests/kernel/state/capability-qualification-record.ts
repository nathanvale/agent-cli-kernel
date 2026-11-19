import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityQualificationRow } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { withoutRepositoryLocation } from "../../../scripts/process-runner.ts";
import { stateCases } from "./cases.ts";
import type { StateCase } from "./cases.ts";

export const recordSchema = "capability-qualification-record/1";
export const recordFolder = "tests/kernel/state/capability-qualification";

export function recordPath(rowId: string): string {
  return `${recordFolder}/${rowId}.json`;
}

export const runEntries = ["fixture.ts", "index.ts"] as const;
export type RunEntry = (typeof runEntries)[number];
const ranResults = ["pass", "fail", "unproved"] as const;

export type CaseResult =
  | {
      readonly id: string;
      readonly result: (typeof ranResults)[number];
      readonly detail: string;
    }
  | {
      readonly id: string;
      readonly result: "not-runnable";
      readonly reason: string;
    };

export type CapabilityQualificationRun = {
  readonly entry: RunEntry;
  readonly commit: string;
  readonly sourceHash: string;
  readonly started: string;
  readonly ended: string;
  readonly cases: readonly CaseResult[];
};

export type PlatformFacts = {
  readonly os: string;
  readonly release: string;
  readonly majorRelease: string;
  readonly architecture: string;
  readonly runtime: string;
  readonly distribution: string;
  readonly cLibrary: string;
  readonly container: boolean;
};

export type CapabilityQualificationRecord = {
  readonly schema: typeof recordSchema;
  readonly row: string;
  readonly factSource: string;
  readonly platform: PlatformFacts;
  readonly filesystem: { readonly type: number };
  readonly primitive: string;
  readonly bootIdentitySource: {
    readonly source: string;
    readonly readable: boolean;
  };
  readonly runs: readonly CapabilityQualificationRun[];
};

const coveredFamilies = [
  ...["K02", "K03", "K06", "K07", "K08", "K11"],
  ...["O04", "O05", "O07", "O09"],
];
const coveredCases = ["Q02.e"];
const needsFactOverride = ["K11.b"];

export function capabilityQualificationCases(
  cases: readonly StateCase[] = stateCases,
): readonly StateCase[] {
  return cases.filter((row) => {
    const short = row.id.slice(0, 5);
    return (
      (coveredFamilies.includes(row.id.slice(0, 3)) &&
        !needsFactOverride.includes(short)) ||
      coveredCases.includes(short)
    );
  });
}

export function caseRegistrations(source: string): readonly string[] {
  return [...source.matchAll(/caseTest\(\s*"([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

export function otherEntryOnly(
  row: StateCase,
  entry: RunEntry,
): { readonly entry: RunEntry; readonly reason: string } | undefined {
  const only = row.status === "executable" ? row.onlyThrough : undefined;
  return only !== undefined && only.entry !== entry ? only : undefined;
}

export function runsThrough(row: StateCase, entry: RunEntry): boolean {
  return (
    row.status === "executable" && otherEntryOnly(row, entry) === undefined
  );
}

export function requiredCaseIds(
  entry: RunEntry,
  cases: readonly StateCase[] = stateCases,
): readonly string[] {
  return capabilityQualificationCases(cases)
    .filter((row) => runsThrough(row, entry))
    .map((row) => row.id);
}

export type SourceFile = { readonly path: string; readonly bytes: Uint8Array };

const qualifiedFolders = [
  "kernel/src/addons/programs",
  "kernel/src/addons/state",
] as const;
const stateSeam = "kernel/src/kernel/state-seam.ts";
const tableFile = "kernel/src/addons/state/capability-qualification-table.ts";

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byPath(left: SourceFile, right: SourceFile): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

export function qualifiedSourceFiles(root: string): readonly SourceFile[] {
  const paths = [
    ...qualifiedFolders.flatMap((folder) =>
      readdirSync(join(root, folder), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => `${folder}/${entry.name}`),
    ),
    stateSeam,
  ].filter((path) => path !== tableFile);
  return paths
    .map((path) => ({ path, bytes: readFileSync(join(root, path)) }))
    .sort(byPath);
}

export function sourceHash(files: readonly SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort(byPath)) {
    hash.update(`${file.path}\n${String(file.bytes.byteLength)}\n`);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

export function own(source: unknown, key: string): unknown {
  return typeof source === "object" &&
    source !== null &&
    Object.hasOwn(source, key)
    ? Reflect.get(source, key)
    : undefined;
}

function fields(source: unknown, keys: readonly string[], where: string) {
  if (typeof source !== "object" || source === null || Array.isArray(source))
    throw new Error(`${where} is not an object`);
  const found = Object.keys(source).sort();
  const wanted = [...keys].sort();
  if (found.join(",") !== wanted.join(","))
    throw new Error(
      `${where} has fields [${found.join(", ")}], not [${wanted.join(", ")}]`,
    );
  return {
    text(key: string): string {
      const value = own(source, key);
      if (typeof value !== "string")
        throw new Error(`${where}.${key} is not text`);
      return value;
    },
    number(key: string): number {
      const value = own(source, key);
      if (typeof value !== "number" || !Number.isInteger(value))
        throw new Error(`${where}.${key} is not a whole number`);
      return value;
    },
    flag(key: string): boolean {
      const value = own(source, key);
      if (typeof value !== "boolean")
        throw new Error(`${where}.${key} is not true or false`);
      return value;
    },
    list(key: string): readonly unknown[] {
      const value = own(source, key);
      if (!Array.isArray(value))
        throw new Error(`${where}.${key} is not a list`);
      return value.map((entry: unknown) => entry);
    },
    value(key: string): unknown {
      return own(source, key);
    },
  };
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  where: string,
): T {
  const found = allowed.find((entry) => entry === value);
  if (found === undefined)
    throw new Error(`${where} is ${value}, not one of ${allowed.join(", ")}`);
  return found;
}

function shaped(value: string, pattern: RegExp, where: string): string {
  if (!pattern.test(value)) throw new Error(`${where} is malformed`);
  return value;
}

function parseCase(source: unknown, where: string): CaseResult {
  const named = own(source, "result");
  if (named === "not-runnable") {
    const entry = fields(source, ["id", "result", "reason"], where);
    return {
      id: entry.text("id"),
      result: named,
      reason: entry.text("reason"),
    };
  }
  const entry = fields(source, ["id", "result", "detail"], where);
  return {
    id: entry.text("id"),
    result: oneOf(entry.text("result"), ranResults, `${where}.result`),
    detail: entry.text("detail"),
  };
}

function parseRun(source: unknown, where: string): CapabilityQualificationRun {
  const run = fields(
    source,
    ["entry", "commit", "sourceHash", "started", "ended", "cases"],
    where,
  );
  return {
    entry: oneOf(run.text("entry"), runEntries, `${where}.entry`),
    commit: shaped(run.text("commit"), /^[0-9a-f]{40}$/, `${where}.commit`),
    sourceHash: shaped(
      run.text("sourceHash"),
      /^[0-9a-f]{64}$/,
      `${where}.sourceHash`,
    ),
    started: run.text("started"),
    ended: run.text("ended"),
    cases: run
      .list("cases")
      .map((entry, index) => parseCase(entry, `${where}.cases[${index}]`)),
  };
}

function parsePlatform(source: unknown): PlatformFacts {
  const platform = fields(
    source,
    [
      ...["os", "release", "majorRelease", "architecture"],
      ...["runtime", "distribution", "cLibrary", "container"],
    ],
    "platform",
  );
  return {
    os: platform.text("os"),
    release: platform.text("release"),
    majorRelease: platform.text("majorRelease"),
    architecture: platform.text("architecture"),
    runtime: platform.text("runtime"),
    distribution: platform.text("distribution"),
    cLibrary: platform.text("cLibrary"),
    container: platform.flag("container"),
  };
}

export function parseRecord(text: string): CapabilityQualificationRecord {
  const parsed: unknown = JSON.parse(text);
  const record = fields(
    parsed,
    [
      ...["schema", "row", "factSource", "platform", "filesystem"],
      ...["primitive", "bootIdentitySource", "runs"],
    ],
    "the record",
  );
  const schema = record.text("schema");
  if (schema !== recordSchema)
    throw new Error(`the schema is ${schema}, not ${recordSchema}`);
  const filesystem = fields(record.value("filesystem"), ["type"], "filesystem");
  const boot = fields(
    record.value("bootIdentitySource"),
    ["source", "readable"],
    "bootIdentitySource",
  );
  return {
    schema,
    row: record.text("row"),
    factSource: record.text("factSource"),
    platform: parsePlatform(record.value("platform")),
    filesystem: { type: filesystem.number("type") },
    primitive: record.text("primitive"),
    bootIdentitySource: {
      source: boot.text("source"),
      readable: boot.flag("readable"),
    },
    runs: record
      .list("runs")
      .map((entry, index) => parseRun(entry, `runs[${index}]`)),
  };
}

function hex(type: number): string {
  return `0x${type.toString(16).toUpperCase()}`;
}

function matchProblems(
  row: CapabilityQualificationRow,
  record: CapabilityQualificationRecord,
): readonly string[] {
  const pairs: readonly (readonly [string, string, string])[] = [
    ["os", record.platform.os, row.os],
    ["majorRelease", record.platform.majorRelease, row.majorRelease],
    ["release", record.platform.release, row.observedRelease],
    ["filesystem type", hex(record.filesystem.type), hex(row.filesystem.type)],
    ["primitive", record.primitive, row.primitive],
    [
      "bootIdentitySource",
      record.bootIdentitySource.source,
      row.bootIdentitySource,
    ],
  ];
  return pairs
    .filter(([, observed, qualified]) => observed !== qualified)
    .map(([name, observed, qualified]) =>
      name === "release"
        ? `release ${observed} differs from the row's observedRelease ${qualified}`
        : `${name} ${observed} differs from the row's ${qualified}`,
    );
}

function caseProblems(
  run: CapabilityQualificationRun,
  row: StateCase,
): readonly string[] {
  const found = run.cases.filter((entry) => entry.id === row.id);
  if (row.status !== "executable") {
    if (found.length === 0)
      return [`the ${run.entry} run has no result for ${row.id}`];
    return found.every((entry) => entry.result === "unproved")
      ? []
      : [
          `${row.id} is pending in the case table, so the ${run.entry} run must record it unproved`,
        ];
  }
  const only = otherEntryOnly(row, run.entry);
  if (only !== undefined)
    return found.length > 0 &&
      found.every(
        (entry) =>
          entry.result === "not-runnable" && entry.reason === only.reason,
      )
      ? []
      : [
          `${row.id} runs only through ${only.entry}, so the ${run.entry} run must mark it not-runnable with the case table's reason`,
        ];
  if (found.length === 0)
    return [`the ${run.entry} run has no result for ${row.id}`];
  const worst = found.find((entry) => entry.result !== "pass");
  if (worst === undefined) return [];
  return worst.result === "not-runnable"
    ? [
        `${row.id} is marked not-runnable in the ${run.entry} run, but the case table runs it there`,
      ]
    : [`${row.id} is ${worst.result} in the ${run.entry} run`];
}

function repeatedIds(run: CapabilityQualificationRun): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of run.cases) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

function runProblems(
  record: CapabilityQualificationRecord,
  currentHash: string,
  cases: readonly StateCase[],
): readonly string[] {
  const entries = record.runs.map((run) => run.entry);
  const shape =
    entries.join(",") === runEntries.join(",")
      ? []
      : [
          `the record holds runs [${entries.join(", ")}]; a row needs fixture.ts, then index.ts`,
        ];
  const covered = capabilityQualificationCases(cases);
  return [
    ...shape,
    ...record.runs.flatMap((run) => [
      ...(run.sourceHash === currentHash
        ? []
        : [
            `the ${run.entry} run's sourceHash ${run.sourceHash} is not the qualified source's ${currentHash}`,
          ]),
      ...repeatedIds(run).map(
        (id) => `the ${run.entry} run lists ${id} more than once`,
      ),
      ...covered.flatMap((row) => caseProblems(run, row)),
    ]),
  ];
}

function calendarDate(date: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (parts === null) return false;
  const [year, month, day] = parts.slice(1).map(Number);
  const read = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  return read.toISOString().slice(0, 10) === date;
}

function reviewProblems(row: CapabilityQualificationRow): readonly string[] {
  const { session, countersignature, date } = row.evidence.review;
  return [
    ...(session.trim() === "" ? ["the row names no reviewing session"] : []),
    ...(countersignature.trim() === ""
      ? ["the row names no countersignature"]
      : []),
    ...(calendarDate(date)
      ? []
      : ["the row names no review date (YYYY-MM-DD)"]),
  ];
}

const gitMilliseconds = 4_000;

export type GitBound = {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly milliseconds?: number;
};

function committedText(
  root: string,
  path: string,
  bound: GitBound,
): string | undefined {
  const limit = bound.milliseconds ?? gitMilliseconds;
  const result = Bun.spawnSync(
    ["git", "-C", root, "cat-file", "blob", `HEAD:${path}`],
    {
      env: withoutRepositoryLocation(bound.environment ?? process.env),
      stdout: "pipe",
      stderr: "pipe",
      timeout: limit,
      killSignal: "SIGKILL",
    },
  );
  if (result.exitedDueToTimeout)
    throw new Error(`git cat-file did not finish within ${String(limit)} ms`);
  return result.exitCode === 0 ? result.stdout.toString("utf8") : undefined;
}

export function rowProblems(
  row: CapabilityQualificationRow,
  root: string,
  currentHash: string,
  cases: readonly StateCase[] = stateCases,
  bound: GitBound = {},
): readonly string[] {
  const expected = recordPath(row.id);
  if (row.evidence.record !== expected)
    return [
      `${row.id} cites ${row.evidence.record}; a row cites its committed capability qualification record ${expected}`,
    ];
  const committed = committedText(root, expected, bound);
  if (committed === undefined)
    return [
      `${row.id}: no committed capability qualification record at ${expected}`,
    ];
  let record: CapabilityQualificationRecord;
  try {
    record = parseRecord(committed);
  } catch (error) {
    return [
      `${row.id}: ${expected} is not a capability qualification record: ${messageOf(error)}`,
    ];
  }
  const problems = [
    ...(record.row === row.id ? [] : [`the record is for row ${record.row}`]),
    ...(record.factSource === "observed"
      ? []
      : [`factSource is ${record.factSource}, not observed`]),
    ...matchProblems(row, record),
    ...(record.bootIdentitySource.readable
      ? []
      : [
          "the boot identity was unreadable in the capability qualification run",
        ]),
    ...runProblems(record, currentHash, cases),
    ...reviewProblems(row),
  ];
  return problems.map((problem) => `${row.id}: ${problem}`);
}
