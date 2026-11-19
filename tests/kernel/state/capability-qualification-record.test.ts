import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  capabilityQualificationTable,
  movedStateRoot,
} from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import type { CapabilityQualificationRow } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  capabilityQualificationCases,
  qualifiedSourceFiles,
  recordPath,
  recordSchema,
  requiredCaseIds,
  rowProblems,
  runEntries,
  sourceHash,
} from "./capability-qualification-record.ts";
import type {
  CapabilityQualificationRecord,
  CapabilityQualificationRun,
  CaseResult,
  RunEntry,
} from "./capability-qualification-record.ts";
import { stateCases } from "./cases.ts";
import type { StateCase } from "./cases.ts";
import { caseTest } from "./harness.ts";

const folder = ownedFolders();
const repository = join(import.meta.dir, "..", "..", "..");

caseTest("Q03.a-row-cites-capability-qualification-record", () => {
  const current = sourceHash(qualifiedSourceFiles(repository));
  expect(current).toMatch(/^[0-9a-f]{64}$/);
  expect(capabilityQualificationTable.map((row) => row.id)).toEqual([]);
  for (const row of capabilityQualificationTable)
    expect({
      row: row.id,
      problems: rowProblems(row, repository, current),
    }).toEqual({ row: row.id, problems: [] });
  return Promise.resolve();
});

test("the capability qualification run covers the closure and stopped-owner cases the design names, from the case table", () => {
  const families = [
    ...["K02", "K03", "K06", "K07", "K08", "K11"],
    ...["O04", "O05", "O07", "O09"],
  ];
  const expected = stateCases
    .filter(
      (row) =>
        (families.includes(row.id.slice(0, 3)) &&
          row.id.slice(0, 5) !== "K11.b") ||
        row.id.slice(0, 5) === "Q02.e",
    )
    .map((row) => row.id);
  const selected = capabilityQualificationCases().map((row) => row.id);
  expect(selected).toEqual(expected);
  expect(selected).toContain("K11.e-transaction-waits-for-started-effects");
  expect(selected.some((id) => id.startsWith("K04."))).toBe(false);
  expect(
    selected.filter((id) => id.startsWith("Q02.")).map((id) => id.slice(0, 5)),
  ).toEqual(["Q02.e"]);
});

test("each capability qualification run requires the cases the case table runs through its entry", () => {
  const covered = capabilityQualificationCases();
  for (const entry of runEntries)
    for (const row of covered)
      expect({
        id: row.id,
        entry,
        required: requiredCaseIds(entry).includes(row.id),
      }).toEqual({
        id: row.id,
        entry,
        required:
          row.status === "executable" &&
          (row.onlyThrough === undefined || row.onlyThrough.entry === entry),
      });
  expect(
    covered.filter(
      (row) =>
        row.status === "executable" && row.onlyThrough?.entry === "fixture.ts",
    ).length,
  ).toBeGreaterThan(0);
  const q02e = covered.filter((row) => row.id.startsWith("Q02.e-"));
  expect(q02e.length).toBe(1);
  for (const row of q02e) {
    expect(requiredCaseIds("index.ts")).toContain(row.id);
    expect(requiredCaseIds("fixture.ts")).not.toContain(row.id);
  }
});

test("K11.f and any later K11 case join both runs' required cases the moment the case table holds them, and K11.b never does", () => {
  const executable = {
    status: "executable",
    layer: "process",
    platform: "coordination",
    sources: "test",
    observation: "test",
    red: "test",
  } as const;
  const rows: readonly StateCase[] = [
    { ...executable, id: "K11.b-delegate-other-boot-closes" },
    { ...executable, id: "K11.f-record-hidden-in-torn-tail-refuses" },
    { ...executable, id: "K11.g-no-append-after-torn-tail" },
  ];
  for (const entry of runEntries)
    expect(requiredCaseIds(entry, rows)).toEqual([
      "K11.f-record-hidden-in-torn-tail-refuses",
      "K11.g-no-append-after-torn-tail",
    ]);
});

test("a case added to a covered family joins the capability qualification run without an edit", () => {
  const added = {
    id: "K11.a-delegate-same-boot-refused",
    status: "executable",
    layer: "process",
    platform: "coordination",
    sources: "test",
    observation: "test",
    red: "test",
  } as const;
  const notCovered = { ...added, id: "K11.b-delegate-other-boot-closes" };
  const pending = {
    id: "K11.c-torn-tail-closes",
    status: "pending",
    supplier: "T2-slice-B",
    reason: "Not built yet.",
    sources: "test",
    observation: "test",
    red: "test",
  } as const;
  const rows = [added, notCovered, pending];
  expect(capabilityQualificationCases(rows).map((row) => row.id)).toEqual([
    "K11.a-delegate-same-boot-refused",
    "K11.c-torn-tail-closes",
  ]);
  expect(requiredCaseIds("fixture.ts", rows)).toEqual([
    "K11.a-delegate-same-boot-refused",
  ]);
  expect(
    requiredCaseIds("fixture.ts", [
      added,
      notCovered,
      { ...added, id: "K11.c-torn-tail-closes" },
    ]),
  ).toEqual(["K11.a-delegate-same-boot-refused", "K11.c-torn-tail-closes"]);
});

const rowId = "linux-7-btrfs";
const current = "c".repeat(64);
const both = {
  id: "K02.a-kill-after-effect-two-later-changes",
  status: "executable",
  layer: "process",
  platform: "coordination",
  sources: "test",
  observation: "test",
  red: "test",
} as const;
const testEntryOnly = {
  ...both,
  id: "K06.e-kill-before-closure-publication",
  onlyThrough: { entry: "fixture.ts", reason: "Waits for a pause point." },
} as const;
const indexOnly = {
  ...both,
  id: "Q02.e-production-row-closes",
  onlyThrough: { entry: "index.ts", reason: "Needs the row in the table." },
} as const;
const pendingRow = {
  id: "K08.c-surviving-delegate-process",
  status: "pending",
  supplier: "T2-slice-B",
  reason: "Needs a delegated program.",
  sources: "test",
  observation: "test",
  red: "test",
} as const;
const table: readonly StateCase[] = [
  both,
  testEntryOnly,
  indexOnly,
  pendingRow,
];

function resultsFor(entry: RunEntry): readonly CaseResult[] {
  return table.map((entryRow): CaseResult => {
    if (entryRow.status === "pending")
      return { id: entryRow.id, result: "unproved", detail: "pending" };
    const only = entryRow.onlyThrough;
    return only !== undefined && only.entry !== entry
      ? { id: entryRow.id, result: "not-runnable", reason: only.reason }
      : { id: entryRow.id, result: "pass", detail: "passed" };
  });
}

function changed(
  entry: RunEntry,
  id: string,
  result: CaseResult | undefined,
): readonly CaseResult[] {
  return resultsFor(entry).flatMap((each) =>
    each.id !== id ? [each] : result === undefined ? [] : [result],
  );
}

function row(
  changes: Partial<CapabilityQualificationRow> = {},
): CapabilityQualificationRow {
  return {
    id: rowId,
    os: "linux",
    majorRelease: "7",
    observedRelease: "7.2.12-orbstack-00394-gbecdd6130068",
    filesystem: { name: "btrfs", type: 0x9123683e },
    primitive: "linux flock(LOCK_EX|LOCK_NB) through libc.so.6",
    bootIdentitySource: "/proc/sys/kernel/random/boot_id",
    processIdentity: "boot identity only",
    namespace: "non-root in a container",
    delegatedWriters: "closure after a delegate start needs another boot",
    failureCases: [movedStateRoot],
    evidence: {
      record: recordPath(rowId),
      review: {
        session: "local_review-session",
        countersignature: "Nathan Vale",
        date: "2026-11-20",
      },
    },
    ...changes,
  };
}

function run(
  entry: CapabilityQualificationRun["entry"],
  changes: Partial<CapabilityQualificationRun> = {},
): CapabilityQualificationRun {
  return {
    entry,
    commit: "a".repeat(40),
    sourceHash: current,
    started: "2026-11-20T01:00:00.000Z",
    ended: "2026-11-20T01:05:00.000Z",
    cases: resultsFor(entry),
    ...changes,
  };
}

function record(
  changes: Partial<CapabilityQualificationRecord> = {},
): CapabilityQualificationRecord {
  return {
    schema: recordSchema,
    row: rowId,
    factSource: "observed",
    platform: {
      os: "linux",
      release: "7.2.12-orbstack-00394-gbecdd6130068",
      majorRelease: "7",
      architecture: "arm64",
      runtime: "bun 1.4.4",
      distribution: "Debian GNU/Linux 13 (trixie)",
      cLibrary: "glibc 2.41",
      container: true,
    },
    filesystem: { type: 0x9123683e },
    primitive: "linux flock(LOCK_EX|LOCK_NB) through libc.so.6",
    bootIdentitySource: {
      source: "/proc/sys/kernel/random/boot_id",
      readable: true,
    },
    runs: [run("fixture.ts"), run("index.ts")],
    ...changes,
  };
}

function problemsFor(
  cited: CapabilityQualificationRow,
  committed: CapabilityQualificationRecord | undefined,
  cases: readonly StateCase[] = table,
): readonly string[] {
  const root = folder("c3-record-");
  if (committed !== undefined) {
    const path = join(root, recordPath(rowId));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(committed, null, 2)}\n`);
  }
  return rowProblems(cited, root, current, cases);
}

test("Q03.a accepts a row whose record holds both runs, every required case passed, on the current source", () => {
  expect(problemsFor(row(), record())).toEqual([]);
});

test("Q03.a refuses a row with no capability qualification record", () => {
  expect(problemsFor(row(), undefined)).toEqual([
    `${rowId}: no capability qualification record at ${recordPath(rowId)}`,
  ]);
});

test("Q03.a refuses a row that cites a hosted run link", () => {
  const link = "https://github.com/nathanvale/agent-cli-kernel/actions/runs/1";
  const cited = row({ evidence: { ...row().evidence, record: link } });
  expect(problemsFor(cited, record())).toEqual([
    `${rowId} cites ${link}; a row cites its committed capability qualification record ${recordPath(rowId)}`,
  ]);
});

test("Q03.a refuses a record whose factSource is not observed", () => {
  expect(problemsFor(row(), record({ factSource: "overridden" }))).toEqual([
    `${rowId}: factSource is overridden, not observed`,
  ]);
});

test("Q03.a refuses a record made for another row", () => {
  expect(problemsFor(row(), record({ row: "linux-7-ext4" }))).toEqual([
    `${rowId}: the record is for row linux-7-ext4`,
  ]);
});

const mismatches: readonly (readonly [
  string,
  CapabilityQualificationRecord,
  string,
])[] = [
  [
    "os",
    record({ platform: { ...record().platform, os: "darwin" } }),
    "os darwin differs from the row's linux",
  ],
  [
    "majorRelease",
    record({ platform: { ...record().platform, majorRelease: "6" } }),
    "majorRelease 6 differs from the row's 7",
  ],
  [
    "observedRelease",
    record({ platform: { ...record().platform, release: "7.3.1" } }),
    "release 7.3.1 differs from the row's observedRelease 7.2.12-orbstack-00394-gbecdd6130068",
  ],
  [
    "filesystem",
    record({ filesystem: { type: 0xef53 } }),
    "filesystem type 0xEF53 differs from the row's 0x9123683E",
  ],
  [
    "primitive",
    record({ primitive: "darwin O_EXLOCK at open" }),
    "primitive darwin O_EXLOCK at open differs from the row's linux flock(LOCK_EX|LOCK_NB) through libc.so.6",
  ],
  [
    "bootIdentitySource",
    record({
      bootIdentitySource: { source: "/proc/self/boot", readable: true },
    }),
    "bootIdentitySource /proc/self/boot differs from the row's /proc/sys/kernel/random/boot_id",
  ],
];

for (const [field, committed, problem] of mismatches)
  test(`Q03.a refuses a record whose ${field} does not match the row`, () => {
    expect(problemsFor(row(), committed)).toEqual([`${rowId}: ${problem}`]);
  });

test("Q03.a refuses a record whose boot identity was unreadable", () => {
  const committed = record({
    bootIdentitySource: { ...record().bootIdentitySource, readable: false },
  });
  expect(problemsFor(row(), committed)).toEqual([
    `${rowId}: the boot identity was unreadable in the capability qualification run`,
  ]);
});

function problemsWithRun(
  entry: RunEntry,
  cases: readonly CaseResult[],
): readonly string[] {
  const runs = runEntries.map((each) =>
    each === entry ? run(each, { cases }) : run(each),
  );
  return problemsFor(row(), record({ runs }));
}

test("Q03.a refuses a record with a failed required case", () => {
  expect(
    problemsWithRun(
      "index.ts",
      changed("index.ts", both.id, {
        id: both.id,
        result: "fail",
        detail: "failed",
      }),
    ),
  ).toEqual([`${rowId}: ${both.id} is fail in the index.ts run`]);
});

test("Q03.a refuses a record whose required case is unproved", () => {
  expect(
    problemsWithRun(
      "fixture.ts",
      changed("fixture.ts", both.id, {
        id: both.id,
        result: "unproved",
        detail: "UNPROVED on darwin: fail-closed control only",
      }),
    ),
  ).toEqual([`${rowId}: ${both.id} is unproved in the fixture.ts run`]);
});

test("Q03.a refuses a second run missing a case it can run", () => {
  expect(
    problemsWithRun("index.ts", changed("index.ts", both.id, undefined)),
  ).toEqual([`${rowId}: the index.ts run has no result for ${both.id}`]);
});

test("Q03.a refuses a second run with no Q02.e result", () => {
  expect(
    problemsWithRun("index.ts", changed("index.ts", indexOnly.id, undefined)),
  ).toEqual([`${rowId}: the index.ts run has no result for ${indexOnly.id}`]);
});

test("Q03.a refuses a run that marks a case not-runnable when the case table runs it there", () => {
  expect(
    problemsWithRun(
      "index.ts",
      changed("index.ts", both.id, {
        id: both.id,
        result: "not-runnable",
        reason: "Claimed without the case table.",
      }),
    ),
  ).toEqual([
    `${rowId}: ${both.id} is marked not-runnable in the index.ts run, but the case table runs it there`,
  ]);
});

const unmarked: readonly (readonly [
  string,
  RunEntry,
  string,
  CaseResult | undefined,
])[] = [
  [
    "passes a test-entry-only case through index.ts",
    "index.ts",
    testEntryOnly.id,
    { id: testEntryOnly.id, result: "pass", detail: "passed" },
  ],
  [
    "leaves out a test-entry-only case",
    "index.ts",
    testEntryOnly.id,
    undefined,
  ],
  [
    "marks a test-entry-only case not-runnable with a reason the case table does not give",
    "index.ts",
    testEntryOnly.id,
    {
      id: testEntryOnly.id,
      result: "not-runnable",
      reason: "Waits for something else.",
    },
  ],
  [
    "passes Q02.e through the test entry",
    "fixture.ts",
    indexOnly.id,
    { id: indexOnly.id, result: "pass", detail: "passed" },
  ],
];

for (const [shape, entry, id, result] of unmarked)
  test(`Q03.a refuses a run that ${shape}`, () => {
    const only = table.find((each) => each.id === id);
    const through =
      only?.status === "executable" ? only.onlyThrough?.entry : undefined;
    expect(problemsWithRun(entry, changed(entry, id, result))).toEqual([
      `${rowId}: ${id} runs only through ${through ?? ""}, so the ${entry} run must mark it not-runnable with the case table's reason`,
    ]);
  });

const unreadable: readonly (readonly [string, string, string])[] = [
  [
    "another schema",
    JSON.stringify({
      ...record(),
      schema: "capability-qualification-record/2",
    }),
    "the schema is capability-qualification-record/2, not capability-qualification-record/1",
  ],
  [
    "an extra field",
    JSON.stringify({ ...record(), hostname: "pilot" }),
    "the record has fields [bootIdentitySource, factSource, filesystem, hostname, platform, primitive, row, runs, schema], not [bootIdentitySource, factSource, filesystem, platform, primitive, row, runs, schema]",
  ],
  [
    "a not-runnable case with no reason field",
    JSON.stringify({
      ...record(),
      runs: [
        {
          ...run("fixture.ts"),
          cases: [
            {
              id: indexOnly.id,
              result: "not-runnable",
            },
          ],
        },
        run("index.ts"),
      ],
    }),
    "runs[0].cases[0] has fields [id, result], not [id, reason, result]",
  ],
  [
    "a not-runnable case that also carries a detail",
    JSON.stringify({
      ...record(),
      runs: [
        {
          ...run("fixture.ts"),
          cases: [
            {
              id: indexOnly.id,
              result: "not-runnable",
              reason: indexOnly.onlyThrough.reason,
              detail: "runs only through index.ts",
            },
          ],
        },
        run("index.ts"),
      ],
    }),
    "runs[0].cases[0] has fields [detail, id, reason, result], not [id, reason, result]",
  ],
  [
    "a malformed sourceHash",
    JSON.stringify({
      ...record(),
      runs: [
        run("fixture.ts", { sourceHash: "c".repeat(63) }),
        run("index.ts"),
      ],
    }),
    "runs[0].sourceHash is malformed",
  ],
  [
    "a short commit",
    JSON.stringify({
      ...record(),
      runs: [run("fixture.ts", { commit: "abc1234" }), run("index.ts")],
    }),
    "runs[0].commit is malformed",
  ],
];

for (const [shape, text, why] of unreadable)
  test(`Q03.a refuses a record with ${shape}`, () => {
    const root = folder("c3-record-");
    const path = join(root, recordPath(rowId));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    expect(rowProblems(row(), root, current, table)).toEqual([
      `${rowId}: ${recordPath(rowId)} is not a capability qualification record: ${why}`,
    ]);
  });

test("Q03.a requires K11.f in both runs once the case table holds it", () => {
  const k11f = {
    ...both,
    id: "K11.f-record-hidden-in-torn-tail-refuses",
  } as const;
  const withK11f = [...table, k11f];
  expect(problemsFor(row(), record(), withK11f)).toEqual([
    `${rowId}: the fixture.ts run has no result for ${k11f.id}`,
    `${rowId}: the index.ts run has no result for ${k11f.id}`,
  ]);
  const passed = { id: k11f.id, result: "pass", detail: "passed" } as const;
  const runs = runEntries.map((entry) =>
    run(entry, { cases: [...resultsFor(entry), passed] }),
  );
  expect(problemsFor(row(), record({ runs }), withK11f)).toEqual([]);
});

test("Q03.a refuses a record missing a required case", () => {
  expect(
    problemsWithRun("fixture.ts", changed("fixture.ts", both.id, undefined)),
  ).toEqual([`${rowId}: the fixture.ts run has no result for ${both.id}`]);
});

test("Q03.a refuses a record with one capability qualification run only", () => {
  expect(problemsFor(row(), record({ runs: [run("fixture.ts")] }))).toEqual([
    `${rowId}: the record holds runs [fixture.ts]; a row needs fixture.ts, then index.ts`,
  ]);
});

test("Q03.a refuses a record whose sourceHash is stale", () => {
  const stale = "d".repeat(64);
  const old = run("index.ts", { sourceHash: stale });
  expect(
    problemsFor(row(), record({ runs: [run("fixture.ts"), old] })),
  ).toEqual([
    `${rowId}: the index.ts run's sourceHash ${stale} is not the qualified source's ${current}`,
  ]);
});

const review = row().evidence.review;
const reviewGaps: readonly (readonly [
  string,
  CapabilityQualificationRow["evidence"]["review"],
  string,
])[] = [
  ["reviewing session", { ...review, session: " " }, "no reviewing session"],
  [
    "countersignature",
    { ...review, countersignature: "" },
    "no countersignature",
  ],
  ["date", { ...review, date: "soon" }, "no review date (YYYY-MM-DD)"],
];

for (const [name, gap, problem] of reviewGaps)
  test(`Q03.a refuses a row that names no ${name}`, () => {
    const cited = row({ evidence: { ...row().evidence, review: gap } });
    expect(problemsFor(cited, record())).toEqual([
      `${rowId}: the row names ${problem}`,
    ]);
  });

function layout(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const scratchSource = {
  "kernel/src/addons/state/install.ts": "install\n",
  "kernel/src/addons/state/capability-qualification-table.ts": "table\n",
  "kernel/src/addons/state/DESIGN.md": "design\n",
  "kernel/src/addons/programs/index.ts": "programs\n",
  "kernel/src/kernel/state-seam.ts": "seam\n",
  "kernel/src/kernel/index.ts": "kernel\n",
};

test("sourceHash covers the state and programs add-on files and the state seam, and leaves out the capability qualification table", () => {
  const root = folder("c3-source-");
  layout(root, scratchSource);
  const files = qualifiedSourceFiles(root);
  expect(files.map((file) => file.path)).toEqual([
    "kernel/src/addons/programs/index.ts",
    "kernel/src/addons/state/install.ts",
    "kernel/src/kernel/state-seam.ts",
  ]);
  const expected = createHash("sha256");
  for (const file of files) {
    expected.update(`${file.path}\n${String(file.bytes.byteLength)}\n`);
    expected.update(file.bytes);
  }
  expect(sourceHash(files)).toBe(expected.digest("hex"));
});

test("sourceHash changes when a qualified file changes by one byte", () => {
  const root = folder("c3-source-");
  layout(root, scratchSource);
  const before = sourceHash(qualifiedSourceFiles(root));
  layout(root, { "kernel/src/addons/state/install.ts": "instalm\n" });
  expect(sourceHash(qualifiedSourceFiles(root))).not.toBe(before);
});

test("sourceHash does not change when the capability qualification table changes", () => {
  const root = folder("c3-source-");
  layout(root, scratchSource);
  const before = sourceHash(qualifiedSourceFiles(root));
  layout(root, {
    "kernel/src/addons/state/capability-qualification-table.ts": "rows\n",
  });
  expect(sourceHash(qualifiedSourceFiles(root))).toBe(before);
});

test("sourceHash is stable across file listing order", () => {
  const root = folder("c3-source-");
  layout(root, scratchSource);
  const files = qualifiedSourceFiles(root);
  expect(sourceHash([...files].reverse())).toBe(sourceHash(files));
});

test("sourceHash frames each file by its path and length", () => {
  const seam = "kernel/src/kernel/state-seam.ts";
  const neighbour = "kernel/src/kernel/state-seam.tt";
  const split = [
    { path: seam, bytes: Buffer.from("a") },
    { path: neighbour, bytes: Buffer.from("b") },
  ];
  const joined = [{ path: seam, bytes: Buffer.from(`a${neighbour}\nb`) }];
  const unframed = (files: typeof split) =>
    files.map((file) => `${file.path}\n${file.bytes.toString()}`).join("");
  expect(unframed(joined)).toBe(unframed(split));
  expect(sourceHash(joined)).not.toBe(sourceHash(split));
});

test("Q03.a refuses a run that lists a case twice, even when one entry passes", () => {
  const cases = [
    { id: both.id, result: "pass", detail: "passed" } as const,
    ...changed("index.ts", both.id, {
      id: both.id,
      result: "fail",
      detail: "failed",
    }),
  ];
  expect(
    problemsFor(
      row(),
      record({ runs: [run("fixture.ts"), run("index.ts", { cases })] }),
    ),
  ).toEqual([
    `${rowId}: the index.ts run lists ${both.id} more than once`,
    `${rowId}: ${both.id} is fail in the index.ts run`,
  ]);
});

const shapes: readonly (readonly [string, unknown, string])[] = [
  ["a list for the record", [], "the record is not an object"],
  [
    "a number for the os",
    { ...record(), platform: { ...record().platform, os: 7 } },
    "platform.os is not text",
  ],
  [
    "text for the filesystem type",
    { ...record(), filesystem: { type: "btrfs" } },
    "filesystem.type is not a whole number",
  ],
  [
    "text for the container flag",
    { ...record(), platform: { ...record().platform, container: "yes" } },
    "platform.container is not true or false",
  ],
  [
    "text for the runs",
    { ...record(), runs: "two" },
    "the record.runs is not a list",
  ],
  [
    "an unknown entry",
    {
      ...record(),
      runs: [{ ...run("fixture.ts"), entry: "main.ts" }, run("index.ts")],
    },
    "runs[0].entry is main.ts, not one of fixture.ts, index.ts",
  ],
  [
    "an unknown result",
    {
      ...record(),
      runs: [
        {
          ...run("fixture.ts"),
          cases: [{ id: both.id, result: "skipped", detail: "x" }],
        },
        run("index.ts"),
      ],
    },
    "runs[0].cases[0].result is skipped, not one of pass, fail, unproved",
  ],
];

for (const [shape, committed, why] of shapes)
  test(`Q03.a refuses a record with ${shape}`, () => {
    const root = folder("c3-record-");
    const path = join(root, recordPath(rowId));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(committed));
    expect(rowProblems(row(), root, current, table)).toEqual([
      `${rowId}: ${recordPath(rowId)} is not a capability qualification record: ${why}`,
    ]);
  });
