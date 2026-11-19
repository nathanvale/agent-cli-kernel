import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  capabilityQualificationTable,
  movedStateRoot,
} from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import type { CapabilityQualificationRow } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  capabilityQualificationCases,
  qualifiedSourceFiles,
  recordPath,
  recordSchema,
  requiredCaseIds,
  rowProblems,
  sourceHash,
} from "./capability-qualification-record.ts";
import type {
  CapabilityQualificationRecord,
  CapabilityQualificationRun,
} from "./capability-qualification-record.ts";
import { stateCases } from "./cases.ts";
import { caseTest } from "./harness.ts";

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
    ...["K02", "K03", "K06", "K07", "K08"],
    ...["O04", "O05", "O07", "O09"],
  ];
  const singles = ["K11.a", "K11.c", "K11.d", "K11.e"];
  const expected = stateCases
    .filter(
      (row) =>
        families.includes(row.id.slice(0, 3)) ||
        singles.includes(row.id.slice(0, 5)),
    )
    .map((row) => row.id);
  const selected = capabilityQualificationCases().map((row) => row.id);
  expect(selected).toEqual(expected);
  expect(selected).toContain("K11.e-transaction-waits-for-started-effects");
  expect(selected).toContain("K08.c-surviving-delegate-process");
  expect(selected.some((id) => id.startsWith("K04."))).toBe(false);
  expect(selected.some((id) => id.startsWith("Q02."))).toBe(false);
  const executable = capabilityQualificationCases()
    .filter((row) => row.status === "executable")
    .map((row) => row.id);
  expect(requiredCaseIds()).toEqual(executable);
  expect(requiredCaseIds()).not.toContain("K08.c-surviving-delegate-process");
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
  const ids = capabilityQualificationCases([added, notCovered]).map(
    (row) => row.id,
  );
  expect(ids).toEqual(["K11.a-delegate-same-boot-refused"]);
  expect(requiredCaseIds([added, notCovered])).toEqual([
    "K11.a-delegate-same-boot-refused",
  ]);
});

const rowId = "linux-7-btrfs";
const current = "c".repeat(64);
const required = [
  "K02.a-kill-after-effect-two-later-changes",
  "K11.e-transaction-waits-for-started-effects",
];
const pendingCase = {
  id: "K08.c-surviving-delegate-process",
  result: "unproved",
  detail: "pending in the case table",
} as const;

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
    cases: [
      ...required.map(
        (id) => ({ id, result: "pass", detail: "passed" }) as const,
      ),
      pendingCase,
    ],
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
): readonly string[] {
  const root = testFolder("c3-record-");
  if (committed !== undefined) {
    const path = join(root, recordPath(rowId));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(committed, null, 2)}\n`);
  }
  return rowProblems(cited, root, current, required);
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

test("Q03.a refuses a record with a failed required case", () => {
  const failed = run("index.ts", {
    cases: [
      { id: required[0] ?? "", result: "fail", detail: "failed" },
      { id: required[1] ?? "", result: "pass", detail: "passed" },
    ],
  });
  expect(
    problemsFor(row(), record({ runs: [run("fixture.ts"), failed] })),
  ).toEqual([`${rowId}: ${required[0] ?? ""} is fail in the index.ts run`]);
});

test("Q03.a refuses a record whose required case is unproved", () => {
  const unproved = run("fixture.ts", {
    cases: [
      {
        id: required[0] ?? "",
        result: "unproved",
        detail: "UNPROVED on darwin: fail-closed control only",
      },
      { id: required[1] ?? "", result: "pass", detail: "passed" },
    ],
  });
  expect(
    problemsFor(row(), record({ runs: [unproved, run("index.ts")] })),
  ).toEqual([
    `${rowId}: ${required[0] ?? ""} is unproved in the fixture.ts run`,
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
    const root = testFolder("c3-record-");
    const path = join(root, recordPath(rowId));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    expect(rowProblems(row(), root, current, required)).toEqual([
      `${rowId}: ${recordPath(rowId)} is not a capability qualification record: ${why}`,
    ]);
  });

test("Q03.a refuses a record missing a required case", () => {
  const missing = run("fixture.ts", {
    cases: [{ id: required[0] ?? "", result: "pass", detail: "passed" }],
  });
  expect(
    problemsFor(row(), record({ runs: [missing, run("index.ts")] })),
  ).toEqual([
    `${rowId}: the fixture.ts run has no result for ${required[1] ?? ""}`,
  ]);
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
  const root = testFolder("c3-source-");
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
  const root = testFolder("c3-source-");
  layout(root, scratchSource);
  const before = sourceHash(qualifiedSourceFiles(root));
  layout(root, { "kernel/src/addons/state/install.ts": "instalm\n" });
  expect(sourceHash(qualifiedSourceFiles(root))).not.toBe(before);
});

test("sourceHash does not change when the capability qualification table changes", () => {
  const root = testFolder("c3-source-");
  layout(root, scratchSource);
  const before = sourceHash(qualifiedSourceFiles(root));
  layout(root, {
    "kernel/src/addons/state/capability-qualification-table.ts": "rows\n",
  });
  expect(sourceHash(qualifiedSourceFiles(root))).toBe(before);
});

test("sourceHash is stable across file listing order", () => {
  const root = testFolder("c3-source-");
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
