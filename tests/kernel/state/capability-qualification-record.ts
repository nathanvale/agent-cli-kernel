import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityQualificationRow } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { stateCases } from "./cases.ts";
import type { StateCase } from "./cases.ts";

export const recordSchema = "capability-qualification-record/1";
export const recordFolder = "tests/kernel/state/capability-qualification";

export function recordPath(rowId: string): string {
  return `${recordFolder}/${rowId}.json`;
}

export const runEntries = ["fixture.ts", "index.ts"] as const;
export type RunEntry = (typeof runEntries)[number];
const caseResultValues = ["pass", "fail", "unproved"] as const;

export type CaseResult = {
  readonly id: string;
  readonly result: (typeof caseResultValues)[number];
  readonly detail: string;
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
  ...["K02", "K03", "K06", "K07", "K08"],
  ...["O04", "O05", "O07", "O09"],
];
const coveredCases = ["K11.a", "K11.c", "K11.d", "K11.e"];

export function capabilityQualificationCases(
  cases: readonly StateCase[] = stateCases,
): readonly StateCase[] {
  return cases.filter(
    (row) =>
      coveredFamilies.includes(row.id.slice(0, 3)) ||
      coveredCases.includes(row.id.slice(0, 5)),
  );
}

export function requiredCaseIds(
  cases: readonly StateCase[] = stateCases,
): readonly string[] {
  return capabilityQualificationCases(cases)
    .filter((row) => row.status === "executable")
    .map((row) => row.id);
}

export type SourceFile = { readonly path: string; readonly bytes: Uint8Array };

const qualifiedFolders = [
  "kernel/src/addons/programs",
  "kernel/src/addons/state",
] as const;
const stateSeam = "kernel/src/kernel/state-seam.ts";
const tableFile = "kernel/src/addons/state/capability-qualification-table.ts";
export const qualifiedPaths: readonly string[] = [
  ...qualifiedFolders,
  stateSeam,
];

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
  const entry = fields(source, ["id", "result", "detail"], where);
  return {
    id: entry.text("id"),
    result: oneOf(entry.text("result"), caseResultValues, `${where}.result`),
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

function runProblems(
  record: CapabilityQualificationRecord,
  currentHash: string,
  required: readonly string[],
): readonly string[] {
  const entries = record.runs.map((run) => run.entry);
  const shape =
    entries.join(",") === runEntries.join(",")
      ? []
      : [
          `the record holds runs [${entries.join(", ")}]; a row needs fixture.ts, then index.ts`,
        ];
  return [
    ...shape,
    ...record.runs.flatMap((run) => [
      ...(run.sourceHash === currentHash
        ? []
        : [
            `the ${run.entry} run's sourceHash ${run.sourceHash} is not the qualified source's ${currentHash}`,
          ]),
      ...required.flatMap((id) => {
        const found = run.cases.find((entry) => entry.id === id);
        if (found === undefined)
          return [`the ${run.entry} run has no result for ${id}`];
        return found.result === "pass"
          ? []
          : [`${id} is ${found.result} in the ${run.entry} run`];
      }),
    ]),
  ];
}

function reviewProblems(row: CapabilityQualificationRow): readonly string[] {
  const { session, countersignature, date } = row.evidence.review;
  return [
    ...(session.trim() === "" ? ["the row names no reviewing session"] : []),
    ...(countersignature.trim() === ""
      ? ["the row names no countersignature"]
      : []),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(date)
      ? []
      : ["the row names no review date (YYYY-MM-DD)"]),
  ];
}

export function rowProblems(
  row: CapabilityQualificationRow,
  root: string,
  currentHash: string,
  required: readonly string[] = requiredCaseIds(),
): readonly string[] {
  const expected = recordPath(row.id);
  if (row.evidence.record !== expected)
    return [
      `${row.id} cites ${row.evidence.record}; a row cites its committed capability qualification record ${expected}`,
    ];
  const path = join(root, expected);
  if (!existsSync(path))
    return [`${row.id}: no capability qualification record at ${expected}`];
  let record: CapabilityQualificationRecord;
  try {
    record = parseRecord(readFileSync(path, "utf8"));
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
    ...runProblems(record, currentHash, required),
    ...reviewProblems(row),
  ];
  return problems.map((problem) => `${row.id}: ${problem}`);
}
