import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { hostname, release, userInfo } from "node:os";
import { join } from "node:path";
import { movedStateRoot } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { resolveCoordination } from "../../../kernel/src/addons/state/coordination.ts";
import { startChild } from "../../../scripts/process-runner.ts";
import {
  commitIn,
  git,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  capabilityQualificationCases,
  parseRecord,
  qualifiedSourceFiles,
  recordFolder,
  recordPath,
  recordSchema,
  rowProblems,
  sourceHash,
} from "./capability-qualification-record.ts";
import type { CapabilityQualificationRecord } from "./capability-qualification-record.ts";
import {
  capabilityQualificationRun,
  caseResults,
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

const candidate: CandidateRow = {
  id: "linux-7-btrfs",
  os: "linux",
  majorRelease: "7",
  observedRelease: "7.2.12-orbstack-00394-gbecdd6130068",
  filesystem: { name: "btrfs", type: 0x9123683e },
  primitive: "linux flock(LOCK_EX|LOCK_NB) through libc.so.6",
  bootIdentitySource: "/proc/sys/kernel/random/boot_id",
};

function junit(selection: readonly StateCase[]): string {
  const cases = selection
    .filter((row) => row.status === "executable")
    .map((row) => `    <testcase name="${row.id}" classname="" time="1" />`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="state">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
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
    environment: Readonly<Record<string, string>> = {},
    seams: Partial<RunContext> = {},
  ): RunContext => ({
    root,
    environment,
    print: (line) => lines.push(line),
    runCases: (request) => {
      requests.push(request);
      return Promise.resolve(junit(request.selection));
    },
    ...seams,
  });
  return {
    base,
    root,
    parent,
    rowFile,
    lines,
    requests,
    context,
    folder: join(root, recordFolder),
    recordFile: join(root, recordPath(candidate.id)),
  };
}

caseTest("Q03.b-capability-qualification-run-refuses", async () => {
  const world = checkout();
  writeFileSync(join(world.root, "notes.txt"), "draft\n");
  expect(
    await capabilityQualificationRun(
      [world.rowFile, world.parent],
      world.context(),
    ),
  ).toBe(1);
  expect(world.lines).toEqual([
    "Refused: the checkout is not clean (?? notes.txt); a capability qualification run records the commit it ran. Repair: commit or remove those changes, then rerun.",
  ]);
  expect(world.requests).toEqual([]);
  expect(existsSync(world.folder)).toBe(false);
});

const overrides: readonly (readonly [string, unknown])[] = [
  ["release", "7.2.12"],
  ["filesystem", 0x9123683e],
  ["bootIdentity", "boot-one"],
  ["devices", { root: 1 }],
];

for (const [fact, value] of overrides)
  test(`Q03.b refuses a ${fact} fact override and writes no record`, async () => {
    const world = checkout();
    const environment = {
      SX_FACT_OVERRIDES: JSON.stringify({ [fact]: value }),
    };
    expect(
      await capabilityQualificationRun(
        [world.rowFile, world.parent],
        world.context(environment),
      ),
    ).toBe(1);
    expect(world.lines).toEqual([
      `Refused: SX_FACT_OVERRIDES is set (${fact}); a capability qualification record holds observed facts only. Repair: unset SX_FACT_OVERRIDES, then rerun.`,
    ]);
    expect(world.requests).toEqual([]);
    expect(existsSync(world.folder)).toBe(false);
  });

test("Q03.b refuses through the command's own entry when a fact override is set", async () => {
  const world = checkout();
  const entry = join(import.meta.dir, "capability-qualification-run.ts");
  const row = { ...candidate, id: "entry-refusal-proof" };
  writeFileSync(world.rowFile, JSON.stringify(row));
  const child = startChild(
    [process.execPath, entry, world.rowFile, world.parent],
    {
      cwd: world.base,
      env: {
        ...inherited(),
        SX_FACT_OVERRIDES: JSON.stringify({ release: "7.2.12" }),
      },
      limitMilliseconds: 30_000,
    },
  );
  const finished = await child.finished;
  expect(finished.timedOut).toBe(false);
  expect(finished.exitCode).toBe(1);
  expect(finished.stdout).toBe(
    "Refused: SX_FACT_OVERRIDES is set (release); a capability qualification record holds observed facts only. Repair: unset SX_FACT_OVERRIDES, then rerun.\n",
  );
  const repository = join(import.meta.dir, "..", "..", "..");
  expect(existsSync(join(repository, recordPath(row.id)))).toBe(false);
});

test("the capability qualification run refuses without its two arguments", async () => {
  const world = checkout();
  expect(
    await capabilityQualificationRun([world.rowFile], world.context()),
  ).toBe(2);
  expect(world.lines).toEqual([
    "Usage: bun run capability-qualification-run <candidate row file> <state root parent> [--entry fixture.ts|index.ts]",
  ]);
  expect(world.requests).toEqual([]);
});

test("a fixture.ts capability qualification run writes the record the design names", async () => {
  const world = checkout();
  expect(
    await capabilityQualificationRun(
      [world.rowFile, world.parent],
      world.context(),
    ),
  ).toBe(0);
  const selection = capabilityQualificationCases();
  expect(world.requests.length).toBe(1);
  const [request] = world.requests;
  expect(request?.entry).toBe("fixture.ts");
  expect(request?.candidate).toEqual(candidate);
  expect(request?.selection.map((row) => row.id)).toEqual(
    selection.map((row) => row.id),
  );
  const text = readFileSync(world.recordFile, "utf8");
  const record = parseRecord(text);
  expect(Object.keys(record).sort()).toEqual([
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
  expect(Object.keys(record.platform).sort()).toEqual([
    "architecture",
    "cLibrary",
    "container",
    "distribution",
    "majorRelease",
    "os",
    "release",
    "runtime",
  ]);
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
  expect(Object.keys(run ?? {}).sort()).toEqual([
    "cases",
    "commit",
    "ended",
    "entry",
    "sourceHash",
    "started",
  ]);
  expect(run?.entry).toBe("fixture.ts");
  expect(run?.commit).toBe(git(world.root, "rev-parse", "HEAD"));
  expect(run?.sourceHash).toBe(sourceHash(qualifiedSourceFiles(world.root)));
  expect(Date.parse(run?.started ?? "")).toBeLessThanOrEqual(
    Date.parse(run?.ended ?? ""),
  );
  expect(run?.cases).toEqual(caseResults(junit(selection), selection));
  expect(world.lines.at(-1)).toStartWith(`Wrote ${recordPath(candidate.id)}: `);
  for (const secret of [
    world.base,
    world.parent,
    userInfo().username,
    hostname(),
  ])
    expect(text).not.toContain(secret);
  if (existsSync(candidate.bootIdentitySource))
    expect(text).not.toContain(
      readFileSync(candidate.bootIdentitySource, "utf8").trim(),
    );
});

test("a killed capability qualification run leaves no record: the temporary file is not one", async () => {
  const world = checkout();
  const killed = capabilityQualificationRun(
    [world.rowFile, world.parent],
    world.context(
      {},
      {
        beforeRename: () => {
          throw new Error("killed before the rename");
        },
      },
    ),
  );
  const stopped = await killed.then(
    () => "finished",
    (error: unknown) => (error instanceof Error ? error.message : "thrown"),
  );
  expect(stopped).toBe("killed before the rename");
  expect(existsSync(world.recordFile)).toBe(false);
  expect(readdirSync(world.folder)).toEqual([`${candidate.id}.json.partial`]);
  const row = {
    ...candidate,
    processIdentity: "boot identity only",
    namespace: "test",
    delegatedWriters: "test",
    failureCases: [movedStateRoot],
    evidence: {
      record: recordPath(candidate.id),
      review: { session: "s", countersignature: "Nathan", date: "2026-11-20" },
    },
  } as const;
  expect(rowProblems(row, world.root, "c".repeat(64))).toEqual([
    `${candidate.id}: no capability qualification record at ${recordPath(candidate.id)}`,
  ]);
});

test("a fixture.ts capability qualification run refuses when the row already has a record", async () => {
  const world = checkout();
  mkdirSync(world.folder, { recursive: true });
  writeFileSync(world.recordFile, "{}\n");
  commitIn(world.root, "an earlier record", {});
  git(world.root, "add", "--", recordPath(candidate.id));
  git(world.root, "commit", "--quiet", "-m", "record");
  expect(
    await capabilityQualificationRun(
      [world.rowFile, world.parent],
      world.context(),
    ),
  ).toBe(1);
  expect(world.lines).toEqual([
    `Refused: ${recordPath(candidate.id)} exists; a fixture.ts run starts a new capability qualification record. Repair: remove it and commit that, then rerun.`,
  ]);
  expect(world.requests).toEqual([]);
  expect(readFileSync(world.recordFile, "utf8")).toBe("{}\n");
});

test("an index.ts capability qualification run refuses a row that is not in the capability qualification table", async () => {
  const world = checkout();
  expect(
    await capabilityQualificationRun(
      [world.rowFile, world.parent, "--entry", "index.ts"],
      world.context(),
    ),
  ).toBe(1);
  expect(world.lines).toEqual([
    `Refused: row ${candidate.id} is not in the capability qualification table. Repair: on the row's own branch, commit the row and its record from one fixture.ts run on this platform, then rerun.`,
  ]);
  expect(world.requests).toEqual([]);
  expect(existsSync(world.folder)).toBe(false);
});

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
