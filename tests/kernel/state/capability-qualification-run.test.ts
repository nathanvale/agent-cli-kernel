import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, release, userInfo } from "node:os";
import { join } from "node:path";
import { movedStateRoot } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { resolveCoordination } from "../../../kernel/src/addons/state/coordination.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  capabilityQualificationCases,
  parseRecord,
  qualifiedSourceFiles,
  recordFolder,
  recordPath,
  recordSchema,
  requiredCaseIds,
  rowProblems,
  sourceHash,
} from "./capability-qualification-record.ts";
import type {
  CapabilityQualificationRecord,
  CaseResult,
} from "./capability-qualification-record.ts";
import {
  capabilityQualificationRun,
  caseFiles,
  caseResults,
  runCasesWithBun,
  runVariable,
  runVariableValue,
  secondRunProblem,
  testNamePattern,
  worldEnvironment,
} from "./capability-qualification-run.ts";
import type {
  CandidateRow,
  CaseRequest,
  ObservedFacts,
  RunContext,
} from "./capability-qualification-run.ts";
import type { StateCase } from "./cases.ts";
import {
  caseTest,
  closeArgs,
  expectCompleted,
  expectRefusedUnchanged,
  makeWorld,
  str,
  supportingTest,
} from "./harness.ts";

const inProcess = 30_000;

const candidate: CandidateRow = {
  id: "linux-7-btrfs",
  os: "linux",
  majorRelease: "7",
  observedRelease: "7.2.12-orbstack-00394-gbecdd6130068",
  filesystem: { name: "btrfs", type: 0x9123683e },
  primitive: "linux flock(LOCK_EX|LOCK_NB) through libc.so.6",
  bootIdentitySource: "/proc/sys/kernel/random/boot_id",
};

const tableRow = {
  ...candidate,
  processIdentity: "boot identity only",
  namespace: "non-root in a container",
  delegatedWriters: "after another boot",
  failureCases: [movedStateRoot],
  evidence: {
    record: recordPath(candidate.id),
    review: { session: "s", countersignature: "Nathan", date: "2026-11-20" },
  },
} as const;

function junit(
  selection: readonly StateCase[],
  failed: readonly string[] = [],
): string {
  const cases = selection
    .filter((row) => row.status === "executable")
    .map((row) =>
      failed.includes(row.id)
        ? `    <testcase name="${row.id}" time="1"><failure message="x" /></testcase>`
        : `    <testcase name="${row.id}" classname="" time="1" />`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="state">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
}

function callerEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(inherited()).filter(([name]) => !name.startsWith("SX_")),
  );
}

function checkout() {
  const base = testFolder("c3-run-");
  const root = join(base, "repository");
  initRepository(root);
  commitIn(root, "qualified source", {
    "kernel/src/addons/state/install.ts": "install\n",
    "kernel/src/addons/programs/index.ts": "programs\n",
    "kernel/src/kernel/state-seam.ts": "seam\n",
  });
  const parent = join(base, "parent");
  mkdirSync(parent);
  const rowFile = join(base, "row.json");
  writeFileSync(rowFile, JSON.stringify(candidate));
  const lines: string[] = [];
  const requests: CaseRequest[] = [];
  const context = (
    environment: Readonly<Record<string, string | undefined>> = {},
    seams: Partial<RunContext> = {},
  ): RunContext => ({
    root,
    cwd: base,
    environment: Object.fromEntries(
      Object.entries({
        ...callerEnvironment(),
        ...gitEnv,
        ...environment,
      }).filter(([, value]) => value !== undefined),
    ),
    print: (line) => lines.push(line),
    runCases: (request) => {
      requests.push(request);
      return Promise.resolve(junit(request.selection));
    },
    ...seams,
  });
  const run = (
    argv: readonly string[] = [rowFile, parent],
    environment: Readonly<Record<string, string | undefined>> = {},
    seams: Partial<RunContext> = {},
  ) => capabilityQualificationRun(argv, context(environment, seams));
  return {
    base,
    root,
    parent,
    rowFile,
    lines,
    requests,
    run,
    folder: join(root, recordFolder),
    recordFile: join(root, recordPath(candidate.id)),
  };
}

type Checkout = ReturnType<typeof checkout>;

function refusedWithoutRecord(world: Checkout, line: string): void {
  expect(world.lines).toEqual([line]);
  expect(world.requests).toEqual([]);
  expect(existsSync(world.recordFile)).toBe(false);
}

const overrideRefusal = (facts: string) =>
  `Refused: SX_FACT_OVERRIDES is set (${facts}); a capability qualification record holds observed facts only. Repair: unset SX_FACT_OVERRIDES, then rerun.`;

caseTest(
  "Q03.b-capability-qualification-run-refuses",
  async () => {
    const dirty = checkout();
    writeFileSync(join(dirty.root, "notes.txt"), "draft\n");
    expect(await dirty.run()).toBe(1);
    refusedWithoutRecord(
      dirty,
      "Refused: the checkout is not clean (?? notes.txt); a capability qualification run records the commit it ran. Repair: commit or remove those changes, then rerun.",
    );
    expect(existsSync(dirty.folder)).toBe(false);
    const overridden = checkout();
    const environment = {
      SX_FACT_OVERRIDES: JSON.stringify({ release: "7.2.12" }),
    };
    expect(await overridden.run(undefined, environment)).toBe(1);
    refusedWithoutRecord(overridden, overrideRefusal("release"));
    expect(existsSync(overridden.folder)).toBe(false);
  },
  inProcess,
);

const overrides: readonly (readonly [string, unknown])[] = [
  ["release", "7.2.12"],
  ["filesystem", 0x9123683e],
  ["bootIdentity", "boot-one"],
  ["devices", { root: 1 }],
];

for (const [fact, value] of overrides)
  test(
    `Q03.b refuses a ${fact} fact override and writes no record`,
    async () => {
      const world = checkout();
      const environment = {
        SX_FACT_OVERRIDES: JSON.stringify({ [fact]: value }),
      };
      expect(await world.run(undefined, environment)).toBe(1);
      refusedWithoutRecord(world, overrideRefusal(fact));
      expect(existsSync(world.folder)).toBe(false);
    },
    inProcess,
  );

test(
  "Q03.b refuses through the command's own entry when a fact override is set",
  async () => {
    const world = checkout();
    const entry = join(import.meta.dir, "capability-qualification-run.ts");
    const row = { ...candidate, id: "entry-refusal-proof" };
    writeFileSync(world.rowFile, JSON.stringify(row));
    const finished = await spawnBounded(
      [process.execPath, entry, world.rowFile, world.parent],
      {
        cwd: world.base,
        env: {
          ...callerEnvironment(),
          SX_FACT_OVERRIDES: JSON.stringify({ release: "7.2.12" }),
        },
        boundMilliseconds: 20_000,
        processGroup: true,
      },
    );
    expect(finished.exit).toBe(1);
    expect(finished.stdout).toBe(`${overrideRefusal("release")}\n`);
    const repository = join(import.meta.dir, "..", "..", "..");
    expect(existsSync(join(repository, recordPath(row.id)))).toBe(false);
  },
  inProcess,
);

const usageLine =
  "Usage: bun run capability-qualification-run <candidate row file> <state root parent> [--entry fixture.ts|index.ts]";

const usages: readonly (readonly string[])[] = [
  ["row.json"],
  ["row.json", "parent", "--entry"],
  ["row.json", "parent", "--entry", "main.ts"],
  ["row.json", "parent", "--from", "index.ts"],
  ["row.json", "parent", "--entry", "index.ts", "again"],
];

for (const argv of usages)
  test(
    `the capability qualification run refuses the arguments ${argv.join(" ")} with its usage`,
    async () => {
      const world = checkout();
      expect(await world.run(argv)).toBe(2);
      refusedWithoutRecord(world, usageLine);
    },
    inProcess,
  );

const rowRepair =
  "Repair: give a JSON file with the row's id, os, majorRelease, observedRelease, filesystem, primitive and bootIdentitySource, then rerun.";
const unreadableRows: readonly (readonly [string, CandidateRow, string])[] = [
  [
    "an id that is not a file name",
    { ...candidate, id: "../linux_7" },
    "id ../linux_7 is not lower-case words joined by hyphens",
  ],
  [
    "a filesystem type that is not a whole number",
    { ...candidate, filesystem: { name: "btrfs", type: 1.5 } },
    "filesystem.type is not a whole number",
  ],
  ["an empty os", { ...candidate, os: "" }, "os is not text"],
];

for (const [shape, row, why] of unreadableRows)
  test(
    `the capability qualification run refuses a candidate row with ${shape}`,
    async () => {
      const world = checkout();
      writeFileSync(world.rowFile, JSON.stringify(row));
      expect(await world.run()).toBe(1);
      refusedWithoutRecord(
        world,
        `Refused: the candidate row ${world.rowFile} is unreadable (${why}). ${rowRepair}`,
      );
    },
    inProcess,
  );

test(
  "the capability qualification run refuses a state root parent that is not a folder",
  async () => {
    const world = checkout();
    expect(await world.run([world.rowFile, world.rowFile])).toBe(1);
    refusedWithoutRecord(
      world,
      `Refused: the state root parent ${world.rowFile} is not a folder. Repair: create it on the filesystem under test, then rerun.`,
    );
  },
  inProcess,
);

test(
  "the capability qualification run refuses qualified source that git ignores",
  async () => {
    const world = checkout();
    commitIn(world.root, "ignore local files", {
      ".gitignore": "*.local.ts\n",
    });
    writeFileSync(
      join(world.root, "kernel/src/addons/state/probe.local.ts"),
      "local\n",
    );
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(
      world,
      "Refused: git ignores qualified source (!! kernel/src/addons/state/probe.local.ts); sourceHash covers committed bytes only. Repair: remove those files, then rerun.",
    );
  },
  inProcess,
);

function expectedResults(
  selection: readonly StateCase[],
  failed: readonly string[] = [],
): readonly CaseResult[] {
  return selection.map((row) =>
    row.status === "pending"
      ? { id: row.id, result: "unproved", detail: `pending: ${row.reason}` }
      : failed.includes(row.id)
        ? {
            id: row.id,
            result: "fail",
            detail: "failed; the run's output shows why",
          }
        : { id: row.id, result: "pass", detail: "passed" },
  );
}

test(
  "a fixture.ts capability qualification run writes the record the design names",
  async () => {
    const world = checkout();
    expect(await world.run(["row.json", "parent"])).toBe(0);
    const selection = capabilityQualificationCases();
    expect(world.requests.length).toBe(1);
    const [request] = world.requests;
    expect(request?.entry).toBe("fixture.ts");
    expect(request?.parent).toBe(world.parent);
    expect(request?.candidate).toEqual(candidate);
    expect(request?.selection.map((row) => row.id)).toEqual(
      selection.map((row) => row.id),
    );
    const text = readFileSync(world.recordFile, "utf8");
    const record = parseRecord(text);
    const raw: unknown = JSON.parse(text);
    const keys =
      typeof raw === "object" && raw !== null ? Object.keys(raw) : [];
    expect(keys.sort()).toEqual([
      "bootIdentitySource",
      "factSource",
      "filesystem",
      "platform",
      "primitive",
      "row",
      "runs",
      "schema",
    ]);
    expect(record.schema).toBe(recordSchema);
    expect(record.row).toBe(candidate.id);
    expect(record.factSource).toBe("observed");
    expect(record.platform.os).toBe(process.platform);
    expect(record.platform.release).toBe(release());
    expect(record.platform.majorRelease).toBe(release().split(".")[0] ?? "");
    expect(record.platform.architecture).toBe(process.arch);
    expect(record.platform.runtime).toBe(`bun ${Bun.version}`);
    expect(record.filesystem).toEqual({ type: statfsSync(world.parent).type });
    const route = resolveCoordination();
    expect(record.primitive).toBe(
      route.available ? route.route : "no coordination route",
    );
    expect(record.bootIdentitySource).toEqual({
      source: candidate.bootIdentitySource,
      readable: existsSync(candidate.bootIdentitySource),
    });
    expect(record.runs.length).toBe(1);
    const [run] = record.runs;
    expect(run?.entry).toBe("fixture.ts");
    expect(run?.commit).toBe(git(world.root, "rev-parse", "HEAD"));
    expect(run?.sourceHash).toBe(sourceHash(qualifiedSourceFiles(world.root)));
    expect(Date.parse(run?.started ?? "")).toBeLessThanOrEqual(
      Date.parse(run?.ended ?? ""),
    );
    expect(run?.cases).toEqual(expectedResults(selection));
    expect(world.lines).toEqual([
      `Wrote ${recordPath(candidate.id)}: ${String(requiredCaseIds().length)} pass, 0 fail, ${String(selection.length - requiredCaseIds().length)} unproved.`,
    ]);
    expectNoIdentity(world, text);
  },
  inProcess,
);

function accountNames(): readonly string[] {
  const uid = process.getuid?.();
  const passwd =
    uid === undefined || !existsSync("/etc/passwd")
      ? []
      : readFileSync("/etc/passwd", "utf8")
          .split("\n")
          .map((line) => line.split(":"))
          .filter((fields) => fields[2] === String(uid))
          .map((fields) => fields[0] ?? "");
  return [
    ...passwd,
    process.env.USER ?? "",
    process.env.LOGNAME ?? "",
    userInfo().username,
    hostname(),
  ].filter((name) => name !== "");
}

function ownStrings(value: unknown, key = ""): readonly string[] {
  if (key === "cases") return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([name, entry]) =>
    ownStrings(entry, name),
  );
}

function expectNoIdentity(world: Checkout, text: string): void {
  const paths = [world.base, world.parent, homedir()].filter(
    (path) => path.length > 1,
  );
  for (const path of paths) expect(text).not.toContain(path);
  if (existsSync(candidate.bootIdentitySource))
    expect(text).not.toContain(
      readFileSync(candidate.bootIdentitySource, "utf8").trim(),
    );
  const fields = ownStrings(JSON.parse(text));
  expect(fields.length).toBeGreaterThan(10);
  for (const name of accountNames())
    expect(fields.filter((field) => field.includes(name))).toEqual([]);
}

test(
  "a capability qualification record names no path, account or machine when USER and LOGNAME are unset",
  async () => {
    const world = checkout();
    expect(
      await world.run(undefined, { USER: undefined, LOGNAME: undefined }),
    ).toBe(0);
    expectNoIdentity(world, readFileSync(world.recordFile, "utf8"));
  },
  inProcess,
);

test(
  "a capability qualification run with a failed required case writes its record and does not qualify the row",
  async () => {
    const world = checkout();
    const [first] = requiredCaseIds();
    if (first === undefined) throw new Error("No required case.");
    const code = await world.run(undefined, undefined, {
      runCases: (request) => Promise.resolve(junit(request.selection, [first])),
    });
    expect(code).toBe(1);
    expect(world.lines.at(-1)).toBe(
      `The fixture.ts run does not qualify row ${candidate.id}: ${first} fail.`,
    );
    expect(
      parseRecord(readFileSync(world.recordFile, "utf8")).runs[0]?.cases,
    ).toEqual(expectedResults(capabilityQualificationCases(), [first]));
  },
  inProcess,
);

test(
  "a capability qualification run whose cases end without a report writes no record",
  async () => {
    const world = checkout();
    const code = await world.run(undefined, undefined, {
      runCases: () => Promise.reject(new Error("the case run wrote no report")),
    });
    expect(code).toBe(1);
    expect(world.lines).toEqual([
      "Refused: the case run ended without results (the case run wrote no report); no capability qualification record is written. Repair: read the run's output above, then rerun.",
    ]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

test(
  "a capability qualification run asked to stop writes no record",
  async () => {
    const world = checkout();
    const code = await world.run(undefined, undefined, { stopped: () => true });
    expect(code).toBe(1);
    expect(world.requests.length).toBe(1);
    expect(world.lines).toEqual([
      "Stopped: the run was asked to stop, so no capability qualification record is written.",
    ]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

test(
  "a killed capability qualification run leaves no record: the temporary file is not one",
  async () => {
    const world = checkout();
    const killed = world.run(undefined, undefined, {
      beforeRename: () => {
        throw new Error("killed before the rename");
      },
    });
    const stopped = await killed.then(
      () => "finished",
      (error: unknown) => (error instanceof Error ? error.message : "thrown"),
    );
    expect(stopped).toBe("killed before the rename");
    expect(existsSync(world.recordFile)).toBe(false);
    expect(readdirSync(world.folder)).toEqual([`${candidate.id}.json.partial`]);
    expect(rowProblems(tableRow, world.root, "c".repeat(64))).toEqual([
      `${candidate.id}: no capability qualification record at ${recordPath(candidate.id)}`,
    ]);
  },
  inProcess,
);

test(
  "a fixture.ts capability qualification run refuses when the row already has a record",
  async () => {
    const world = checkout();
    commitIn(world.root, "an earlier record", {
      [recordPath(candidate.id)]: "{}\n",
    });
    expect(await world.run()).toBe(1);
    expect(world.lines).toEqual([
      `Refused: ${recordPath(candidate.id)} exists; a fixture.ts run starts a new capability qualification record. Repair: remove it and commit that, then rerun.`,
    ]);
    expect(world.requests).toEqual([]);
    expect(readFileSync(world.recordFile, "utf8")).toBe("{}\n");
  },
  inProcess,
);

const secondRepair =
  "Repair: on the row's own branch, commit the row and its record from one fixture.ts run on this platform, then rerun.";

test(
  "an index.ts capability qualification run refuses a row that is not in the capability qualification table",
  async () => {
    const world = checkout();
    expect(
      await world.run([world.rowFile, world.parent, "--entry", "index.ts"]),
    ).toBe(1);
    refusedWithoutRecord(
      world,
      `Refused: row ${candidate.id} is not in the capability qualification table. ${secondRepair}`,
    );
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

test(
  "an index.ts capability qualification run refuses a record it cannot read",
  async () => {
    const world = checkout();
    commitIn(world.root, "a damaged record", {
      [recordPath(candidate.id)]: "{}\n",
    });
    expect(
      await world.run(
        [world.rowFile, world.parent, "--entry", "index.ts"],
        undefined,
        { table: [tableRow] },
      ),
    ).toBe(1);
    expect(world.lines).toEqual([
      `Refused: ${recordPath(candidate.id)} is not a capability qualification record (the record has fields [], not [bootIdentitySource, factSource, filesystem, platform, primitive, row, runs, schema]). ${secondRepair}`,
    ]);
    expect(world.requests).toEqual([]);
    expect(readFileSync(world.recordFile, "utf8")).toBe("{}\n");
  },
  inProcess,
);

test(
  "an index.ts capability qualification run appends to the record its fixture.ts run wrote",
  async () => {
    const world = checkout();
    expect(await world.run()).toBe(0);
    const first = parseRecord(readFileSync(world.recordFile, "utf8"));
    git(world.root, "add", "--", recordPath(candidate.id));
    git(world.root, "commit", "--quiet", "-m", "the fixture.ts record");
    expect(
      await world.run(
        [world.rowFile, world.parent, "--entry", "index.ts"],
        undefined,
        { table: [tableRow] },
      ),
    ).toBe(0);
    expect(world.requests.map((request) => request.entry)).toEqual([
      "fixture.ts",
      "index.ts",
    ]);
    const both = parseRecord(readFileSync(world.recordFile, "utf8"));
    expect(both.runs.map((run) => run.entry)).toEqual([
      "fixture.ts",
      "index.ts",
    ]);
    expect(both.runs[0]).toEqual(first.runs[0]);
    expect({ ...both, runs: [] }).toEqual({ ...first, runs: [] });
    expect(both.runs[1]?.commit).toBe(git(world.root, "rev-parse", "HEAD"));
    expect(both.runs[1]?.sourceHash).toBe(first.runs[0]?.sourceHash);
  },
  inProcess,
);

const observed: ObservedFacts = {
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
  primitive: candidate.primitive,
  bootIdentitySource: { source: candidate.bootIdentitySource, readable: true },
};
const firstRun = {
  entry: "fixture.ts",
  commit: "a".repeat(40),
  sourceHash: "c".repeat(64),
  started: "2026-11-20T01:00:00.000Z",
  ended: "2026-11-20T01:05:00.000Z",
  cases: [],
} as const;
const earlier: CapabilityQualificationRecord = {
  schema: recordSchema,
  row: candidate.id,
  factSource: "observed",
  ...observed,
  runs: [firstRun],
};

test("an index.ts capability qualification run needs the row in the table and one fixture.ts run on this platform", () => {
  expect(secondRunProblem([tableRow], candidate, earlier, observed)).toBe(
    undefined,
  );
  expect(secondRunProblem([], candidate, earlier, observed)).toBe(
    `row ${candidate.id} is not in the capability qualification table`,
  );
  expect(
    secondRunProblem(
      [{ ...tableRow, majorRelease: "6" }],
      candidate,
      earlier,
      observed,
    ),
  ).toBe(
    `row ${candidate.id} in the capability qualification table differs from the candidate row in majorRelease`,
  );
  expect(secondRunProblem([tableRow], candidate, undefined, observed)).toBe(
    `no capability qualification record at ${recordPath(candidate.id)} from a fixture.ts run`,
  );
  expect(
    secondRunProblem(
      [tableRow],
      candidate,
      { ...earlier, runs: [firstRun, { ...firstRun, entry: "index.ts" }] },
      observed,
    ),
  ).toBe(
    "the record holds runs [fixture.ts, index.ts]; the index.ts run follows exactly one fixture.ts run",
  );
  expect(
    secondRunProblem([tableRow], candidate, earlier, {
      ...observed,
      filesystem: { type: 0xef53 },
    }),
  ).toBe("this platform differs from the record's in filesystem");
});

const synthetic: readonly StateCase[] = [
  ...["a", "b", "c", "d", "f"].map(
    (letter) =>
      ({
        id: `K02.${letter}-synthetic`,
        status: "executable",
        layer: "process",
        platform: "coordination",
        sources: "test",
        observation: "test",
        red: "test",
      }) as const,
  ),
  {
    id: "K08.e-synthetic-pending",
    status: "pending",
    supplier: "T2-slice-B",
    reason: "Needs a delegated program.",
    sources: "test",
    observation: "test",
    red: "test",
  },
];

test("each case result comes from its own test in the run's report", () => {
  const report = [
    "<testsuites><testsuite>",
    '<testcase name="K02.a-synthetic" time="1" />',
    '<testcase name="K02.b-synthetic" time="1"><failure message="x">at /home/x</failure></testcase>',
    '<testcase name="K02.c-synthetic UNPROVED on darwin: fail-closed control only" time="1" />',
    '<testcase name="K02.f-synthetic" time="0"><skipped /></testcase>',
    '<testcase name="K02.a-synthetic-other" time="1"><failure /></testcase>',
    "</testsuite></testsuites>",
  ].join("\n");
  expect(caseResults(report, synthetic)).toEqual([
    { id: "K02.a-synthetic", result: "pass", detail: "passed" },
    {
      id: "K02.b-synthetic",
      result: "fail",
      detail: "failed; the run's output shows why",
    },
    {
      id: "K02.c-synthetic",
      result: "unproved",
      detail: "UNPROVED on darwin: fail-closed control only",
    },
    {
      id: "K02.d-synthetic",
      result: "fail",
      detail: "no test ran for this case",
    },
    { id: "K02.f-synthetic", result: "fail", detail: "skipped" },
    {
      id: "K08.e-synthetic-pending",
      result: "unproved",
      detail: "pending: Needs a delegated program.",
    },
  ]);
});

test("the run's test name pattern selects each executable case and its UNPROVED title only", () => {
  const pattern = new RegExp(testNamePattern(synthetic));
  expect(pattern.test("K02.a-synthetic")).toBe(true);
  expect(pattern.test("K02.c-synthetic UNPROVED on darwin: x")).toBe(true);
  expect(pattern.test("K02.a-synthetic-other")).toBe(false);
  expect(pattern.test("K02xa-synthetic")).toBe(false);
  expect(pattern.test("K08.e-synthetic-pending")).toBe(false);
  expect(pattern.test("CMD-11 supporting: K02.a-synthetic")).toBe(false);
});

test("a capability qualification run tells each world its entry and candidate row", () => {
  expect(worldEnvironment(undefined, "fixture")).toBe(undefined);
  const first = runVariableValue("fixture.ts", candidate);
  expect(worldEnvironment(first, "fixture")).toEqual({
    SX_CANDIDATE_ROW: JSON.stringify({
      os: candidate.os,
      majorRelease: candidate.majorRelease,
      observedRelease: candidate.observedRelease,
      filesystemName: candidate.filesystem.name,
      filesystemType: candidate.filesystem.type,
      primitive: candidate.primitive,
      bootIdentitySource: candidate.bootIdentitySource,
    }),
  });
  expect(worldEnvironment(first, undefined)).toEqual({});
  const second = runVariableValue("index.ts", candidate);
  expect(worldEnvironment(second, "fixture")).toEqual({
    SX_ENTRY: "production",
  });
  expect(worldEnvironment(second, undefined)).toEqual({
    SX_ENTRY: "production",
  });
  expect(() => worldEnvironment("{", "fixture")).toThrow(
    `${runVariable} is not a capability qualification run`,
  );
});

function worldUnder(value: string | undefined) {
  const saved = process.env[runVariable];
  if (value === undefined) delete process.env[runVariable];
  else process.env[runVariable] = value;
  try {
    return makeWorld({ qualification: "fixture" });
  } finally {
    if (saved === undefined) delete process.env[runVariable];
    else process.env[runVariable] = saved;
  }
}

const apply = ["apply", "a", "--content", "v1", "--json"];

supportingTest(
  "Q03 supporting: a fixture.ts capability qualification run closes through the candidate row",
  async () => {
    const control = worldUnder(undefined);
    const run = worldUnder(
      runVariableValue("fixture.ts", { ...candidate, majorRelease: "0" }),
    );
    try {
      for (const world of [control, run]) await world.killAt(apply, "effect");
      const ids = [control, run].map((world) => {
        const [operation] = world.operations();
        if (!operation) throw new Error("No operation.");
        return operation.id;
      });
      expectCompleted(
        await control.run(
          closeArgs(ids[0] ?? "", await control.revision(ids[0] ?? "")),
        ),
      );
      const refused = await run.run(
        closeArgs(ids[1] ?? "", await run.revision(ids[1] ?? "")),
      );
      expectRefusedUnchanged(refused, "DOMAIN_SX_UNAVAILABLE");
      const message = str(refused.envelope.message);
      expect(message).toStartWith(
        "State unavailable: stopped-owner-proof-unqualified (observed os ",
      );
      expect(message).toContain("differs in");
      expect(message).toContain("major release");
    } finally {
      control.dispose();
      run.dispose();
    }
  },
);

test("Q03 supporting: an index.ts capability qualification run starts every world through index.ts", async () => {
  const control = worldUnder(undefined);
  const run = worldUnder(runVariableValue("index.ts", candidate));
  try {
    for (const world of [control, run]) await world.run(["pending", "--json"]);
    expect(control.count("entry production")).toBe(0);
    expect(run.count("entry production")).toBe(1);
  } finally {
    control.dispose();
    run.dispose();
  }
});

test("Q03 supporting: a world in a capability qualification run refuses a fact override or candidate row of its own", async () => {
  const run = worldUnder(runVariableValue("fixture.ts", candidate));
  try {
    for (const name of ["SX_FACT_OVERRIDES", "SX_CANDIDATE_ROW"]) {
      const refused = await run
        .run(["pending", "--json"], { [name]: "{}" })
        .then(
          () => "ran",
          (error: unknown) =>
            error instanceof Error ? error.message : "thrown",
        );
      expect(refused).toBe(
        `A capability qualification run sets no ${name} for one test: every world runs on observed facts and the candidate row.`,
      );
    }
    expect(run.ledger()).toEqual([]);
  } finally {
    run.dispose();
  }
});

function registered(id: string, body: string, title = id): string {
  return `caseTest(${JSON.stringify(id)}, () => { ${body} }, ${JSON.stringify(title)});`;
}

function caseFile(lines: readonly string[]): string {
  return [
    'import { expect, test } from "bun:test";',
    "function caseTest(id: string, body: () => void, title = id) {",
    "  test(title, body);",
    "}",
    ...lines,
    "",
  ].join("\n");
}

test(
  "the capability qualification run's own case runner loads only the files that hold covered cases and reads each case from Bun's report",
  async () => {
    const base = testFolder("c3-runner-");
    const parent = join(base, "parent");
    const scratch = join(base, "scratch");
    const marker = join(base, "loaded");
    const folder = join(base, "tests", "kernel", "state");
    for (const path of [folder, parent, scratch])
      mkdirSync(path, { recursive: true });
    writeFileSync(
      join(folder, "synthetic.test.ts"),
      caseFile([
        registered(
          "K02.a-synthetic",
          `expect(process.env.STATE_TEST_DIR).toBe(${JSON.stringify(parent)}); expect(JSON.parse(process.env.${runVariable} ?? "{}").entry).toBe("fixture.ts");`,
        ),
        registered("K02.b-synthetic", "expect(1).toBe(2);"),
        registered(
          "K02.c-synthetic",
          "",
          "K02.c-synthetic UNPROVED on darwin: fail-closed control only",
        ),
        registered("K02.f-synthetic", 'throw new Error("not in the pattern");'),
      ]),
    );
    writeFileSync(
      join(folder, "noise.test.ts"),
      caseFile([
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "loaded\\n");`,
        registered("Z99.a-not-covered", ""),
      ]),
    );
    const selection = synthetic.filter((row) => row.id !== "K02.f-synthetic");
    expect(caseFiles(base, selection)).toEqual([
      "tests/kernel/state/synthetic.test.ts",
    ]);
    const output: string[] = [];
    const report = await runCasesWithBun(
      {
        root: base,
        parent,
        entry: "fixture.ts",
        candidate,
        selection,
        environment: { ...callerEnvironment(), TMPDIR: scratch },
        output: (text) => output.push(text),
      },
      20_000,
    );
    expect(output.join("")).toContain("K02.b-synthetic");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    expect(caseResults(report, synthetic)).toEqual([
      { id: "K02.a-synthetic", result: "pass", detail: "passed" },
      {
        id: "K02.b-synthetic",
        result: "fail",
        detail: "failed; the run's output shows why",
      },
      {
        id: "K02.c-synthetic",
        result: "unproved",
        detail: "UNPROVED on darwin: fail-closed control only",
      },
      {
        id: "K02.d-synthetic",
        result: "fail",
        detail: "no test ran for this case",
      },
      { id: "K02.f-synthetic", result: "fail", detail: "skipped" },
      {
        id: "K08.e-synthetic-pending",
        result: "unproved",
        detail: "pending: Needs a delegated program.",
      },
    ]);
  },
  inProcess,
);

test(
  "the capability qualification run's own case runner refuses a selection no file holds",
  async () => {
    const base = testFolder("c3-runner-");
    const parent = join(base, "parent");
    mkdirSync(join(base, "tests", "kernel", "state"), { recursive: true });
    mkdirSync(parent);
    const refused = await runCasesWithBun(
      {
        root: base,
        parent,
        entry: "fixture.ts",
        candidate,
        selection: synthetic,
        environment: callerEnvironment(),
        output: () => undefined,
      },
      20_000,
    ).then(
      () => "ran",
      (error: unknown) => (error instanceof Error ? error.message : "thrown"),
    );
    expect(refused).toBe("no file in tests/kernel/state holds a covered case");
    expect(readdirSync(parent)).toEqual([]);
  },
  inProcess,
);

const repository = join(import.meta.dir, "..", "..", "..");

test("the run loads the files that register the covered cases, and not the coordination probe", () => {
  const files = caseFiles(repository, capabilityQualificationCases());
  expect(files).toContain("tests/kernel/state/recovery.test.ts");
  expect(files).toContain("tests/kernel/state/component.test.ts");
  expect(files).not.toContain(
    "tests/kernel/state/linux-coordination.probe.test.ts",
  );
  const sources = files.map((path) =>
    readFileSync(join(repository, path), "utf8"),
  );
  for (const id of requiredCaseIds())
    expect(sources.some((source) => source.includes(`"${id}"`))).toBe(true);
});

test("a case run over the repository's covered files leaves nothing outside its state root parent", async () => {
  const base = testFolder("c3-runner-");
  const parent = join(base, "parent");
  const scratch = join(base, "scratch");
  for (const path of [parent, scratch]) mkdirSync(path);
  const selection = capabilityQualificationCases().filter((row) =>
    ["K02.a", "K11.e"].includes(row.id.slice(0, 5)),
  );
  expect(caseFiles(repository, selection)).toEqual([
    "tests/kernel/state/component.test.ts",
    "tests/kernel/state/recovery.test.ts",
  ]);
  const report = await runCasesWithBun(
    {
      root: repository,
      parent,
      entry: "fixture.ts",
      candidate,
      selection,
      environment: { ...callerEnvironment(), TMPDIR: scratch },
      output: () => undefined,
    },
    40_000,
  );
  expect(
    caseResults(report, selection).filter(
      (entry) => entry.detail === "no test ran for this case",
    ),
  ).toEqual([]);
  expect(readdirSync(parent)).toEqual([]);
  expect(readdirSync(scratch)).toEqual([]);
}, 90_000);
