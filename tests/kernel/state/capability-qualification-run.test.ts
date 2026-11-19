import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, release, type } from "node:os";
import { dirname, join, resolve } from "node:path";
import { movedStateRoot } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { resolveCoordination } from "../../../kernel/src/addons/state/coordination.ts";
import { bootIdentitySource } from "../../../kernel/src/addons/state/qualification.ts";
import {
  commitIn,
  git,
  gitOutput,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
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
  runEntries,
  sourceHash,
} from "./capability-qualification-record.ts";
import type {
  CapabilityQualificationRecord,
  CaseResult,
  RunEntry,
} from "./capability-qualification-record.ts";
import {
  bootIdentityReadableAt,
  capabilityQualificationRun,
  caseFiles,
  caseResults,
  distributionOf,
  reportedTwice,
  runCasesWithBun,
  runOf,
  runVariable,
  runVariableValue,
  secondRunProblem,
  testNamePattern,
  worldEnvironment,
} from "./capability-qualification-run.ts";
import type {
  CandidateRow,
  CaseRequest,
  CaseRun,
  ObservedFacts,
  RunContext,
} from "./capability-qualification-run.ts";
import type { StateCase } from "./cases.ts";
import {
  caseTest,
  closeArgs,
  closureLabel,
  expectCompleted,
  expectRefusedUnchanged,
  makeWorld,
  str,
  supportingTest,
} from "./harness.ts";

const folder = ownedFolders();
const inProcess = 30_000;
const refusalBound = 20_000;
const caseRunBound = 50_000;
const caseRunTimeout = 120_000;

const candidate: CandidateRow = {
  id: "linux-7-btrfs",
  os: "linux",
  majorRelease: "7",
  observedRelease: "7.2.12-orbstack-00394-gbecdd6130068",
  filesystem: { name: "btrfs", type: 0x9123683e },
  primitive: "linux flock(LOCK_EX|LOCK_NB) through libc.so.6",
  bootIdentitySource: "/proc/self/candidate-boot-identity",
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

function ran(report: string, exitCode = 0): CaseRun {
  return { report, exitCode };
}

function bootIdentityReadable(): boolean {
  try {
    return readFileSync(bootIdentitySource, "utf8").trim() !== "";
  } catch {
    return false;
  }
}

function callerEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(inherited()).filter(
      ([name]) => !name.startsWith("SX_") && name !== "CQ_ENV_FILE",
    ),
  );
}

test("the run tests start each child without a CQ_ENV_FILE the parent process set", () => {
  const saved = process.env.CQ_ENV_FILE;
  process.env.CQ_ENV_FILE = "parent";
  try {
    expect(Object.hasOwn(callerEnvironment(), "CQ_ENV_FILE")).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.CQ_ENV_FILE;
    else process.env.CQ_ENV_FILE = saved;
  }
});

function checkout() {
  const base = folder("c3-run-");
  const root = join(base, "repository");
  initRepository(root);
  commitIn(root, "qualified source", {
    "kernel/src/addons/state/install.ts": "install\n",
    "kernel/src/addons/programs/index.ts": "programs\n",
    "kernel/src/kernel/state-seam.ts": "seam\n",
  });
  symlinkSync("state", join(root, "kernel/src/addons/linked-state"));
  git(root, "add", "--", "kernel/src/addons/linked-state");
  git(root, "commit", "--quiet", "-m", "a tracked link to a folder");
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
      return Promise.resolve(ran(junit(request.selection)));
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
      "Refused: git ignores files where the run loads code (!! kernel/src/addons/state/probe.local.ts); a capability qualification run loads committed files only. Repair: remove those files, then rerun.",
    );
  },
  inProcess,
);

function expectedResults(
  selection: readonly StateCase[],
  entry: RunEntry,
): readonly CaseResult[] {
  return selection.map((row): CaseResult => {
    if (row.status === "pending")
      return {
        id: row.id,
        result: "unproved",
        detail: `pending: ${row.reason}`,
      };
    const only = row.onlyThrough;
    if (only !== undefined && only.entry !== entry)
      return { id: row.id, result: "not-runnable", reason: only.reason };
    return { id: row.id, result: "pass", detail: "passed" };
  });
}

function summary(results: readonly CaseResult[]): string {
  const count = (result: CaseResult["result"]) =>
    String(results.filter((entry) => entry.result === result).length);
  return `${count("pass")} pass, ${count("fail")} fail, ${count("unproved")} unproved, ${count("not-runnable")} not-runnable.`;
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
      source: bootIdentitySource,
      readable: bootIdentityReadable(),
    });
    expect(record.runs.length).toBe(1);
    const [run] = record.runs;
    expect(run?.entry).toBe("fixture.ts");
    expect(run?.commit).toBe(git(world.root, "rev-parse", "HEAD"));
    expect(run?.sourceHash).toBe(sourceHash(qualifiedSourceFiles(world.root)));
    expect(Date.parse(run?.started ?? "")).toBeLessThanOrEqual(
      Date.parse(run?.ended ?? ""),
    );
    const expected = expectedResults(selection, "fixture.ts");
    expect(run?.cases).toEqual(expected);
    expect(
      expected.filter((entry) => entry.result === "not-runnable").length,
    ).toBeGreaterThan(0);
    expect(world.lines).toEqual([
      `Wrote ${recordPath(candidate.id)}: ${summary(expected)}`,
    ]);
    expectNoIdentity(world, text);
  },
  inProcess,
);

function osRelease(): string | undefined {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return undefined;
  }
}

function expectNoIdentity(
  world: Checkout,
  text: string,
  markers: readonly string[] = [],
): void {
  const paths = [world.base, world.parent, homedir()].filter(
    (path) => path.length > 1,
  );
  for (const path of paths) expect(text).not.toContain(path);
  if (bootIdentityReadable())
    expect(text).not.toContain(readFileSync(bootIdentitySource, "utf8").trim());
  const { platform } = parseRecord(text);
  expect(platform.release).toBe(release());
  expect(platform.distribution).toBe(distributionOf(osRelease(), type()));
  expect(platform.cLibrary).toMatch(
    /^(?:glibc \d+(?:\.\d+)*|musl|unknown|not read off Linux)$/,
  );
  for (const marker of markers) expect(text).not.toContain(marker);
}

const identityMarkers = {
  USER: "cq-account-marker",
  LOGNAME: "cq-login-marker",
  HOSTNAME: "cq-machine-marker",
};

test(
  "a capability qualification record copies no account or machine name its process environment gives it",
  async () => {
    const world = checkout();
    const names = Object.keys(identityMarkers);
    const saved = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(identityMarkers))
      process.env[name] = value;
    try {
      expect(await world.run(undefined, identityMarkers)).toBe(0);
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    expectNoIdentity(
      world,
      readFileSync(world.recordFile, "utf8"),
      Object.values(identityMarkers),
    );
  },
  inProcess,
);

test(
  "a capability qualification record holds no path, and no account or machine name in its host-read fields, when USER and LOGNAME are unset",
  async () => {
    const world = checkout();
    const saved = { USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    delete process.env.USER;
    delete process.env.LOGNAME;
    const seen: (string | undefined)[] = [];
    try {
      const code = await world.run(
        undefined,
        { USER: undefined, LOGNAME: undefined },
        {
          runCases: (request) => {
            seen.push(
              process.env.USER,
              process.env.LOGNAME,
              request.environment.USER,
              request.environment.LOGNAME,
            );
            return Promise.resolve(ran(junit(request.selection)));
          },
        },
      );
      expect(code).toBe(0);
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
    expectNoIdentity(world, readFileSync(world.recordFile, "utf8"));
  },
  inProcess,
);

test(
  "a capability qualification run with a failed required case writes its record and does not qualify the row",
  async () => {
    const world = checkout();
    const [first] = requiredCaseIds("fixture.ts");
    if (first === undefined) throw new Error("No required case.");
    const code = await world.run(undefined, undefined, {
      runCases: (request) =>
        Promise.resolve(ran(junit(request.selection, [first]), 1)),
    });
    expect(code).toBe(1);
    expect(world.lines.at(-1)).toBe(
      `The fixture.ts run does not qualify row ${candidate.id}: ${first} fail.`,
    );
    const cases =
      parseRecord(readFileSync(world.recordFile, "utf8")).runs[0]?.cases ?? [];
    expect(cases.find((entry) => entry.id === first)).toEqual({
      id: first,
      result: "fail",
      detail: "failed; the run's output shows why",
    });
  },
  inProcess,
);

test(
  "a capability qualification run refuses a test process that exited 0 though a covered case failed",
  async () => {
    const world = checkout();
    const [first] = requiredCaseIds("fixture.ts");
    if (first === undefined) throw new Error("No required case.");
    const code = await world.run(undefined, undefined, {
      runCases: (request) =>
        Promise.resolve(ran(junit(request.selection, [first]), 0)),
    });
    expect(code).toBe(1);
    expect(world.lines).toEqual([
      `Refused: the case run's test process exited 0, but ${first} failed in its report; the evidence does not agree, so no capability qualification record is written. Repair: read the run's output above, then rerun.`,
    ]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

test(
  "a capability qualification run with a required case that never ran writes its record and does not qualify the row",
  async () => {
    const world = checkout();
    const [first] = requiredCaseIds("fixture.ts");
    if (first === undefined) throw new Error("No required case.");
    const code = await world.run(undefined, undefined, {
      runCases: (request) =>
        Promise.resolve(
          ran(junit(request.selection.filter((row) => row.id !== first))),
        ),
    });
    expect(code).toBe(1);
    expect(world.lines.at(-1)).toBe(
      `The fixture.ts run does not qualify row ${candidate.id}: ${first} fail.`,
    );
    const cases =
      parseRecord(readFileSync(world.recordFile, "utf8")).runs[0]?.cases ?? [];
    expect(cases.find((entry) => entry.id === first)).toEqual({
      id: first,
      result: "fail",
      detail: "no test ran for this case",
    });
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
      `${candidate.id}: no committed capability qualification record at ${recordPath(candidate.id)}`,
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
      await world.run(
        [world.rowFile, world.parent, "--entry", "index.ts"],
        undefined,
        { table: [] },
      ),
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
  "an index.ts capability qualification run appends to the record its fixture.ts run wrote, and Q03.a accepts the pair",
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
    git(world.root, "add", "--", recordPath(candidate.id));
    git(world.root, "commit", "--quiet", "-m", "the index.ts record");
    const judged = {
      ...tableRow,
      os: first.platform.os,
      majorRelease: first.platform.majorRelease,
      observedRelease: first.platform.release,
      filesystem: { name: "observed", type: first.filesystem.type },
      primitive: first.primitive,
      bootIdentitySource,
    };
    expect(
      rowProblems(
        judged,
        world.root,
        sourceHash(qualifiedSourceFiles(world.root)),
      ),
    ).toEqual(
      bootIdentityReadable()
        ? []
        : [
            `${candidate.id}: the boot identity was unreadable in the capability qualification run`,
          ],
    );
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

test("an index.ts capability qualification run refuses a record for another row", () => {
  for (const row of ["linux-7-ext4", "../linux-7-ext4"])
    expect(
      secondRunProblem([tableRow], candidate, { ...earlier, row }, observed),
    ).toBe(`the record at ${recordPath(candidate.id)} is for row ${row}`);
});

for (const row of ["linux-7-ext4", "../linux-7-ext4"])
  test(
    `an index.ts capability qualification run refuses a committed record for row ${row} before any case runs, and writes nothing`,
    async () => {
      const world = checkout();
      expect(await world.run()).toBe(0);
      const first = parseRecord(readFileSync(world.recordFile, "utf8"));
      const moved = `${JSON.stringify({ ...first, row }, null, 2)}\n`;
      writeFileSync(world.recordFile, moved);
      git(world.root, "add", "--", recordPath(candidate.id));
      git(world.root, "commit", "--quiet", "-m", "a record for another row");
      expect(
        await world.run(
          [world.rowFile, world.parent, "--entry", "index.ts"],
          undefined,
          { table: [tableRow] },
        ),
      ).toBe(1);
      expect(world.requests.map((request) => request.entry)).toEqual([
        "fixture.ts",
      ]);
      expect(world.lines.at(-1)).toBe(
        `Refused: the record at ${recordPath(candidate.id)} is for row ${row}. Repair: on the row's own branch, commit the row and its record from one fixture.ts run on this platform, then rerun.`,
      );
      expect(readdirSync(world.folder)).toEqual([`${candidate.id}.json`]);
      expect(readFileSync(world.recordFile, "utf8")).toBe(moved);
      expect(git(world.root, "status", "--porcelain")).toBe("");
    },
    inProcess,
  );

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
    id: "K02.g-synthetic",
    status: "executable",
    layer: "process",
    platform: "coordination",
    onlyThrough: { entry: "index.ts", reason: "Needs the row in the table." },
    sources: "test",
    observation: "test",
    red: "test",
  },
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

const syntheticNotRunnable = {
  id: "K02.g-synthetic",
  result: "not-runnable",
  reason: "Needs the row in the table.",
} as const;

test("each case result comes from its own test in the run's report", () => {
  const report = [
    "<testsuites><testsuite>",
    '<testcase name="K02.a-synthetic" time="1" />',
    '<testcase name="K02.b-synthetic" time="1"><failure message="x">at /home/x</failure></testcase>',
    '<testcase name="K02.c-synthetic UNPROVED on darwin: fail-closed control only" time="1" />',
    '<testcase name="K02.f-synthetic" time="0"><skipped /></testcase>',
    '<testcase name="K02.a-synthetic-other" time="1"><failure /></testcase>',
    '<testcase name="K02.g-synthetic" time="1"><failure /></testcase>',
    '<testcase name="K02.d-synthetic and more words" time="1" />',
    "</testsuite></testsuites>",
  ].join("\n");
  expect(caseResults(report, synthetic, "fixture.ts")).toEqual([
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
    syntheticNotRunnable,
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
  expect(pattern.test("K02.a-synthetic and more words")).toBe(false);
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
  expect(runOf(undefined)).toBe(undefined);
  expect(runOf(second)).toEqual({ entry: "index.ts", candidate });
});

test("closureLabel expects the row id in an index.ts capability qualification run, and the fixture label otherwise", () => {
  const saved = process.env[runVariable];
  const labels: string[] = [];
  try {
    for (const value of [
      undefined,
      runVariableValue("fixture.ts", candidate),
      runVariableValue("index.ts", candidate),
    ]) {
      if (value === undefined) delete process.env[runVariable];
      else process.env[runVariable] = value;
      labels.push(closureLabel());
    }
  } finally {
    if (saved === undefined) delete process.env[runVariable];
    else process.env[runVariable] = saved;
  }
  expect(labels).toEqual([
    "fixture:specimen",
    "fixture:specimen",
    candidate.id,
  ]);
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
  return `caseTest(${JSON.stringify(id)}, async () => { ${body} }, ${JSON.stringify(title)});`;
}

function caseFile(lines: readonly string[]): string {
  return [
    'import { expect, test } from "bun:test";',
    "function caseTest(id: string, body: () => Promise<void>, title = id) {",
    "  test(title, body);",
    "}",
    ...lines,
    "",
  ].join("\n");
}

function runnerWorld() {
  const base = folder("c3-runner-");
  const parent = join(base, "parent");
  const outside = join(base, "outside");
  const cases = join(base, "tests", "kernel", "state");
  for (const path of [cases, parent, outside])
    mkdirSync(path, { recursive: true });
  const request = (
    selection: readonly StateCase[],
    files: readonly string[] = [],
    root = base,
    output: (text: string) => void = () => undefined,
  ): CaseRequest => ({
    root,
    parent,
    entry: "fixture.ts",
    candidate,
    selection,
    files,
    environment: { ...callerEnvironment(), TMPDIR: outside },
    output,
  });
  return { base, parent, outside, cases, request };
}

async function withOwnTemporaryFolders<T>(
  folder: string,
  body: () => Promise<T>,
): Promise<T> {
  const saved = {
    STATE_TEST_DIR: process.env.STATE_TEST_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.STATE_TEST_DIR = folder;
  process.env.TMPDIR = folder;
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

function loadedFiles(report: string): readonly string[] {
  return [...report.matchAll(/<testsuite\b[^>]*\bfile="([^"]*)"/g)]
    .map((match) => (match[1] ?? "").replace(/^\.\//, ""))
    .sort();
}

test(
  "the capability qualification run's own case runner loads only the files that hold covered cases, skips each case its entry cannot run, and reads each case from Bun's report",
  async () => {
    const world = runnerWorld();
    writeFileSync(
      join(world.cases, "synthetic.test.ts"),
      caseFile([
        registered(
          "K02.a-synthetic",
          `expect(process.env.CQ_ENV_FILE).toBe(undefined); expect(process.env.STATE_TEST_DIR).toBe(${JSON.stringify(world.parent)}); expect(JSON.parse(process.env.${runVariable} ?? "{}").entry).toBe("fixture.ts"); expect(require("node:fs").readdirSync(process.env.STATE_TEST_DIR).filter((name: string) => name.startsWith(".capability-qualification-run-")).length).toBe(1);`,
        ),
        registered("K02.b-synthetic", "expect(1).toBe(2);"),
        registered(
          "K02.c-synthetic",
          "",
          "K02.c-synthetic UNPROVED on darwin: fail-closed control only",
        ),
        registered("K02.f-synthetic", 'throw new Error("not in the pattern");'),
        registered("K02.g-synthetic", 'throw new Error("index.ts only");'),
      ]),
    );
    writeFileSync(
      join(world.cases, "stray.test.ts"),
      caseFile([
        'import { writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'writeFileSync(join(tmpdir(), "stray"), "loaded\\n");',
        registered("K02.a-synthetic", ""),
      ]),
    );
    writeFileSync(
      join(world.cases, "noise.test.ts"),
      caseFile([
        'import { writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'writeFileSync(join(tmpdir(), "loaded"), "loaded\\n");',
        registered("K02.e-synthetic", ""),
      ]),
    );
    writeFileSync(join(world.base, ".env"), "CQ_ENV_FILE=loaded\n");
    const selection = synthetic.filter((row) => row.id !== "K02.f-synthetic");
    expect(
      caseFiles(world.base, selection, [
        "tests/kernel/state/noise.test.ts",
        "tests/kernel/state/synthetic.test.ts",
      ]),
    ).toEqual(["tests/kernel/state/synthetic.test.ts"]);
    const output: string[] = [];
    const { report, exitCode } = await withOwnTemporaryFolders(
      world.outside,
      () =>
        runCasesWithBun(
          world.request(
            selection,
            [
              "tests/kernel/state/noise.test.ts",
              "tests/kernel/state/synthetic.test.ts",
            ],
            world.base,
            (text) => output.push(text),
          ),
          caseRunBound,
        ),
    );
    expect(exitCode).toBe(1);
    expect(output.join("")).toContain("K02.b-synthetic");
    expect(report).toMatch(
      /<testcase name="K02\.g-synthetic"[^>]*>\s*<skipped/,
    );
    expect(loadedFiles(report)).toEqual([
      "tests/kernel/state/synthetic.test.ts",
    ]);
    expect(readdirSync(world.parent)).toEqual([]);
    expect(readdirSync(world.outside)).toEqual([]);
    expect(caseResults(report, synthetic, "fixture.ts")).toEqual([
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
      syntheticNotRunnable,
      {
        id: "K08.e-synthetic-pending",
        result: "unproved",
        detail: "pending: Needs a delegated program.",
      },
    ]);
    const control = synthetic
      .filter((row) => row.id === "K02.a-synthetic")
      .map((row) => ({ ...row, id: "K02.e-synthetic" }));
    const controlRun = await withOwnTemporaryFolders(world.outside, () =>
      runCasesWithBun(
        world.request(control, ["tests/kernel/state/noise.test.ts"]),
        caseRunBound,
      ),
    );
    expect(controlRun.exitCode).toBe(0);
    expect(readdirSync(world.outside)).toEqual(["loaded"]);
  },
  caseRunTimeout,
);

test(
  "the capability qualification run's own case runner refuses a selection no file holds",
  async () => {
    const world = runnerWorld();
    const refused = await runCasesWithBun(
      world.request(synthetic),
      refusalBound,
    ).then(
      () => "ran",
      (error: unknown) => (error instanceof Error ? error.message : "thrown"),
    );
    expect(refused).toBe(
      "no file in tests/kernel/state registers a covered case",
    );
    expect(readdirSync(world.parent)).toEqual([]);
  },
  inProcess,
);

test(
  "a capability qualification run names the repair when no file registers a covered case",
  async () => {
    const world = checkout();
    mkdirSync(join(world.base, "tests", "kernel", "state"), {
      recursive: true,
    });
    const code = await world.run(undefined, undefined, {
      runCases: (request) =>
        runCasesWithBun({ ...request, root: world.base }, refusalBound),
    });
    expect(code).toBe(1);
    expect(world.lines).toEqual([
      "Refused: the case run ended without results (no file in tests/kernel/state registers a covered case); no capability qualification record is written. Repair: register each covered case with caseTest in tests/kernel/state, then rerun.",
    ]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

const repository = join(import.meta.dir, "..", "..", "..");

test("the run loads the files that register the covered cases, and not the coordination probe", () => {
  for (const entry of runEntries) {
    const runnable = capabilityQualificationCases().filter(
      (row) =>
        row.status === "executable" &&
        (row.onlyThrough === undefined || row.onlyThrough.entry === entry),
    );
    const files = caseFiles(
      repository,
      runnable,
      trackedStateTests(repository),
    );
    expect(files).not.toContain(
      "tests/kernel/state/linux-coordination.probe.test.ts",
    );
    const sources = files.map((path) =>
      readFileSync(join(repository, path), "utf8"),
    );
    for (const id of requiredCaseIds(entry))
      expect(sources.some((source) => source.includes(`"${id}"`))).toBe(true);
  }
});

test(
  "a fixture.ts case run over the repository's covered files loads only them and leaves nothing outside its state root parent",
  async () => {
    const world = runnerWorld();
    const selection = capabilityQualificationCases();
    const runnable = selection.filter(
      (row) =>
        row.status === "executable" &&
        (row.onlyThrough === undefined ||
          row.onlyThrough.entry === "fixture.ts"),
    );
    const { report } = await withOwnTemporaryFolders(world.outside, () =>
      runCasesWithBun(
        world.request(selection, trackedStateTests(repository), repository),
        caseRunBound,
      ),
    );
    expect(reportedTwice(report, selection)).toEqual([]);
    expect(loadedFiles(report)).toEqual(
      caseFiles(repository, runnable, trackedStateTests(repository)),
    );
    expect(
      caseResults(report, selection, "fixture.ts").filter(
        (entry) =>
          entry.result === "fail" &&
          entry.detail === "no test ran for this case",
      ),
    ).toEqual([]);
    expect(readdirSync(world.parent)).toEqual([]);
    expect(readdirSync(world.outside)).toEqual([]);
  },
  caseRunTimeout,
);

const committedBytes =
  "a capability qualification run reads committed bytes only.";

for (const flag of ["assume-unchanged", "skip-worktree"] as const)
  test(
    `the capability qualification run refuses a tracked file git marks ${flag}`,
    async () => {
      const world = checkout();
      const path = "kernel/src/addons/state/install.ts";
      git(world.root, "update-index", `--${flag}`, "--", path);
      writeFileSync(join(world.root, path), "replaced\n");
      expect(git(world.root, "status", "--porcelain")).toBe("");
      expect(await world.run()).toBe(1);
      refusedWithoutRecord(
        world,
        `Refused: git hides changes to tracked files (${flag} ${path}); ${committedBytes} Repair: clear the flag with git update-index --no-assume-unchanged or --no-skip-worktree, then rerun.`,
      );
    },
    inProcess,
  );

test(
  "the capability qualification run refuses a tracked file whose bytes differ from the commit when git status cannot see it",
  async () => {
    const world = checkout();
    const path = "kernel/src/addons/state/install.ts";
    git(world.root, "config", "core.trustctime", "false");
    git(world.root, "config", "core.checkStat", "minimal");
    const file = join(world.root, path);
    const earlier = new Date(statSync(file).mtimeMs - 3_600_000);
    utimesSync(file, earlier, earlier);
    git(world.root, "update-index", "--really-refresh");
    writeFileSync(file, "instalm\n");
    utimesSync(file, earlier, earlier);
    expect(git(world.root, "status", "--porcelain")).toBe("");
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(
      world,
      `Refused: tracked files differ from their committed bytes (${path}); ${committedBytes} Repair: restore or commit them, then rerun.`,
    );
  },
  inProcess,
);

test(
  "a capability qualification run refuses a report that names a case twice",
  async () => {
    const world = checkout();
    const [first] = requiredCaseIds("fixture.ts");
    if (first === undefined) throw new Error("No required case.");
    const code = await world.run(undefined, undefined, {
      runCases: (request) =>
        Promise.resolve(
          ran(
            junit(request.selection).replace(
              "</testsuite>",
              `<testcase name="${first}" time="1" />\n  </testsuite>`,
            ),
          ),
        ),
    });
    expect(code).toBe(1);
    expect(world.lines).toEqual([
      `Refused: Bun reported ${first} twice; no capability qualification record is written. Repair: give each covered case one test, then rerun.`,
    ]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

test(
  "a capability qualification run refuses a test process that exited non-zero with no covered case failing",
  async () => {
    const world = checkout();
    const code = await world.run(undefined, undefined, {
      runCases: (request) => Promise.resolve(ran(junit(request.selection), 1)),
    });
    expect(code).toBe(1);
    expect(world.lines).toEqual([
      "Refused: the case run's test process exited 1, but no covered case failed in its report; the evidence does not agree, so no capability qualification record is written. Repair: read the run's output above, then rerun.",
    ]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

test(
  "the capability qualification run bounds each git read",
  async () => {
    const world = checkout();
    const bin = folder("c3-stub-git-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n", {
      mode: 0o755,
    });
    const started = performance.now();
    const stopped = await world
      .run(
        undefined,
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
        { gitMilliseconds: 300 },
      )
      .then(
        () => "finished",
        (error: unknown) => (error instanceof Error ? error.message : "thrown"),
      );
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(stopped).toStartWith("git ");
    expect(stopped).toEndWith(" did not finish within 300 ms");
    expect(world.requests).toEqual([]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

async function runnerRefusal(
  lines: readonly string[],
  limit: number,
): Promise<{
  readonly refused: string;
  readonly parent: readonly string[];
  readonly quick: boolean;
}> {
  const world = runnerWorld();
  writeFileSync(join(world.cases, "synthetic.test.ts"), caseFile(lines));
  const started = performance.now();
  const refused = await runCasesWithBun(
    world.request(
      synthetic.filter((row) => row.id === "K02.a-synthetic"),
      ["tests/kernel/state/synthetic.test.ts"],
    ),
    limit,
  ).then(
    () => "ran",
    (error: unknown) => (error instanceof Error ? error.message : "thrown"),
  );
  return {
    refused,
    parent: readdirSync(world.parent),
    quick: performance.now() - started < 2_500,
  };
}

test(
  "the capability qualification run's own case runner stops a case run that outlives its bound",
  async () => {
    expect(
      await runnerRefusal(
        [
          registered(
            "K02.a-synthetic",
            "await new Promise((resolve) => setTimeout(resolve, 4_000));",
          ),
        ],
        500,
      ),
    ).toEqual({
      refused: "the case run outlived its 500 ms limit",
      parent: [],
      quick: true,
    });
  },
  inProcess,
);

test(
  "the capability qualification run's own case runner refuses a case run that writes no report",
  async () => {
    expect(
      await runnerRefusal(
        ["process.exit(0);", registered("K02.a-synthetic", "")],
        refusalBound,
      ),
    ).toEqual({
      refused: "the case run wrote no report",
      parent: [],
      quick: true,
    });
  },
  inProcess,
);

test("a capability qualification record names the distribution by its os-release ID and VERSION_ID only", () => {
  expect(
    distributionOf(
      'PRETTY_NAME="Debian GNU/Linux 13 (trixie) at nathan-pc"\nID=debian\nVERSION_ID="13"\n',
      "Linux",
    ),
  ).toBe("debian 13");
  expect(
    distributionOf('ID="my distro; rm -rf"\nVERSION_ID=1.2\n', "Linux"),
  ).toBe("mydistrorm-rf 1.2");
  expect(distributionOf(`ID=${"x".repeat(40)}\n`, "Linux")).toBe(
    "x".repeat(32),
  );
  expect(distributionOf('PRETTY_NAME="Some Linux"\n', "Linux")).toBe("Linux");
  expect(distributionOf(undefined, "Darwin")).toBe("Darwin");
});

const tamperedWorkingTree: readonly (readonly [
  string,
  (root: string) => void,
  string,
])[] = [
  [
    "a deleted tracked file",
    (root) => rmSync(join(root, "kernel/src/addons/programs/index.ts")),
    "kernel/src/addons/programs/index.ts (missing)",
  ],
  [
    "a tracked link replaced by a folder of the same name",
    (root) => {
      rmSync(join(root, "kernel/src/addons/linked-state"));
      mkdirSync(join(root, "kernel/src/addons/linked-state"));
    },
    "kernel/src/addons/linked-state (not a link)",
  ],
  [
    "a tracked file replaced by a folder",
    (root) => {
      rmSync(join(root, "kernel/src/kernel/state-seam.ts"));
      mkdirSync(join(root, "kernel/src/kernel/state-seam.ts"));
    },
    "kernel/src/kernel/state-seam.ts (not a file)",
  ],
];

for (const [shape, tamper, listed] of tamperedWorkingTree)
  test(
    `the capability qualification run refuses ${shape}`,
    async () => {
      const world = checkout();
      tamper(world.root);
      expect(await world.run()).toBe(1);
      refusedWithoutRecord(
        world,
        `Refused: tracked files differ from their committed bytes (${listed}); ${committedBytes} Repair: restore or commit them, then rerun.`,
      );
    },
    inProcess,
  );

test(
  "the capability qualification run refuses a repository that is not sha1",
  async () => {
    const world = checkout();
    const root = join(world.base, "sha256");
    mkdirSync(root);
    git(root, "init", "--quiet", "--object-format=sha256");
    commitIn(root, "qualified source", {
      "kernel/src/addons/state/install.ts": "install\n",
      "kernel/src/addons/programs/index.ts": "programs\n",
      "kernel/src/kernel/state-seam.ts": "seam\n",
    });
    const lines: string[] = [];
    const code = await capabilityQualificationRun(
      [world.rowFile, world.parent],
      {
        root,
        cwd: world.base,
        environment: { ...callerEnvironment(), ...gitEnv },
        print: (line) => lines.push(line),
        runCases: () => Promise.reject(new Error("no case run expected")),
      },
    );
    expect(code).toBe(1);
    expect(lines).toEqual([
      "Refused: the repository's object format is sha256; a capability qualification record names a 40-character sha1 commit. Repair: run from a sha1 clone.",
    ]);
  },
  inProcess,
);

test(
  "a capability qualification run ignores a repeated test name that is not a covered case",
  async () => {
    const world = checkout();
    const code = await world.run(undefined, undefined, {
      runCases: (request) =>
        Promise.resolve(
          ran(
            junit(request.selection).replace(
              "</testsuite>",
              '<testcase name="Z99.a-not-covered" time="0"><skipped /></testcase>\n<testcase name="Z99.a-not-covered" time="0"><skipped /></testcase>\n  </testsuite>',
            ),
          ),
        ),
    });
    expect(code).toBe(0);
    expect(existsSync(world.recordFile)).toBe(true);
  },
  inProcess,
);

function trackedStateTests(root: string): readonly string[] {
  return gitOutput(root, "ls-files", "-z", "--", "tests/kernel/state")
    .split("\0")
    .filter((path) => path.endsWith(".test.ts"));
}

test(
  "a Bun child started in the checkout loads its .env, so the capability qualification run refuses one there",
  async () => {
    const world = checkout();
    writeFileSync(join(world.root, ".env"), "CQ_ENV_FILE=loaded\n");
    const child = await spawnBounded(
      [
        process.execPath,
        "-e",
        "console.log(process.env.CQ_ENV_FILE ?? 'unset')",
      ],
      {
        cwd: world.root,
        env: Object.fromEntries(
          Object.entries(callerEnvironment()).filter(
            ([name]) => name !== "CQ_ENV_FILE",
          ),
        ),
        boundMilliseconds: 10_000,
      },
    );
    expect(child.stdout.trim()).toBe("loaded");
    commitIn(world.root, "ignore dotenv files", { ".gitignore": ".env\n" });
    expect(git(world.root, "status", "--porcelain")).toBe("");
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(
      world,
      "Refused: dotenv files sit where the run's processes start (.env); Bun would load them into any child started without --no-env-file. Repair: move them out of the checkout, then rerun.",
    );
  },
  inProcess,
);

test(
  "the capability qualification run refuses an ignored file in a folder it loads code from",
  async () => {
    const world = checkout();
    commitIn(world.root, "ignore local tests", {
      ".gitignore": "*.local.test.ts\n",
    });
    mkdirSync(join(world.root, "tests/kernel/state"), { recursive: true });
    writeFileSync(
      join(world.root, "tests/kernel/state/sneaky.local.test.ts"),
      `${registered("K02.a-kill-after-effect-two-later-changes", "")}\n`,
    );
    expect(git(world.root, "status", "--porcelain")).toBe("");
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(
      world,
      "Refused: git ignores files where the run loads code (!! tests/kernel/state/sneaky.local.test.ts); a capability qualification run loads committed files only. Repair: remove those files, then rerun.",
    );
  },
  inProcess,
);

test(
  "a capability qualification run hands its case runner the files the commit tracks under tests/kernel/state",
  async () => {
    const world = checkout();
    commitIn(world.root, "a case file", {
      "tests/kernel/state/recovery.test.ts": `${registered("K02.a-kill-after-effect-two-later-changes", "")}\n`,
      "tests/kernel/state/notes.md": "not a test\n",
    });
    expect(await world.run()).toBe(0);
    expect(world.requests.map((request) => request.files)).toEqual([
      ["tests/kernel/state/notes.md", "tests/kernel/state/recovery.test.ts"],
    ]);
  },
  inProcess,
);

test(
  "the capability qualification run refuses a tree entry it cannot check, a submodule among them",
  async () => {
    const world = checkout();
    const path = "kernel/src/addons/module";
    const head = git(world.root, "rev-parse", "HEAD");
    git(
      world.root,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},${path}`,
    );
    git(world.root, "commit", "--quiet", "-m", "a submodule");
    mkdirSync(join(world.root, path), { recursive: true });
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(
      world,
      `Refused: tracked files differ from their committed bytes (${path} (mode 160000 is not checked)); ${committedBytes} Repair: restore or commit them, then rerun.`,
    );
  },
  inProcess,
);

test("the boot identity counts as readable only when the file reads as non-empty text", () => {
  const root = folder("c3-boot-");
  const write = (name: string, text: string) => {
    writeFileSync(join(root, name), text);
    return join(root, name);
  };
  expect(bootIdentityReadableAt(join(root, "absent"))).toBe(false);
  expect(bootIdentityReadableAt(write("empty", ""))).toBe(false);
  expect(bootIdentityReadableAt(write("blank", " \n"))).toBe(false);
  expect(bootIdentityReadableAt(write("boot", "boot-one\n"))).toBe(true);
  expect(bootIdentityReadableAt(root)).toBe(false);
});

test(
  "a capability qualification run refuses a non-zero exit explained only by a test that is not a covered case's own",
  async () => {
    const world = checkout();
    const [first] = requiredCaseIds("fixture.ts");
    if (first === undefined) throw new Error("No required case.");
    const code = await world.run(undefined, undefined, {
      runCases: (request) =>
        Promise.resolve(
          ran(
            junit(request.selection).replace(
              "</testsuite>",
              `<testcase name="${first} and more words" time="1"><failure message="x" /></testcase>\n  </testsuite>`,
            ),
            1,
          ),
        ),
    });
    expect(code).toBe(1);
    expect(world.lines).toEqual([
      "Refused: the case run's test process exited 1, but no covered case failed in its report; the evidence does not agree, so no capability qualification record is written. Repair: read the run's output above, then rerun.",
    ]);
    expect(existsSync(world.folder)).toBe(false);
  },
  inProcess,
);

for (const name of [".env.test", ".Env.local"])
  test(
    `the capability qualification run refuses a ${name} file in the repository root`,
    async () => {
      const world = checkout();
      commitIn(world.root, "ignore dotenv files", {
        ".gitignore": ".env*\n.Env*\n",
      });
      writeFileSync(join(world.root, name), "CQ_ENV_FILE=loaded\n");
      expect(git(world.root, "status", "--porcelain")).toBe("");
      expect(await world.run()).toBe(1);
      refusedWithoutRecord(
        world,
        `Refused: dotenv files sit where the run's processes start (${name}); Bun would load them into any child started without --no-env-file. Repair: move them out of the checkout, then rerun.`,
      );
    },
    inProcess,
  );

test(
  "the capability qualification run accepts a committed .env.example, which Bun does not load",
  async () => {
    const world = checkout();
    commitIn(world.root, "an example", { ".env.example": "CQ_ENV_FILE=\n" });
    expect(await world.run()).toBe(0);
    expect(existsSync(world.recordFile)).toBe(true);
  },
  inProcess,
);

for (const folder of ["scripts", "src"])
  test(
    `the capability qualification run refuses an ignored file under ${folder}`,
    async () => {
      const world = checkout();
      commitIn(world.root, "ignore local code", {
        ".gitignore": "*.local.ts\n",
      });
      mkdirSync(join(world.root, folder), { recursive: true });
      writeFileSync(join(world.root, folder, "probe.local.ts"), "local\n");
      expect(git(world.root, "status", "--porcelain")).toBe("");
      expect(await world.run()).toBe(1);
      refusedWithoutRecord(
        world,
        `Refused: git ignores files where the run loads code (!! ${folder}/probe.local.ts); a capability qualification run loads committed files only. Repair: remove those files, then rerun.`,
      );
    },
    inProcess,
  );

function linkedSharedFolder(): Checkout {
  const world = checkout();
  commitIn(world.root, "a shared folder outside the load folders", {
    ".gitignore": "*.local.ts\n",
    "docs/shared/keep.ts": "kept\n",
  });
  symlinkSync("../../docs/shared", join(world.root, "kernel/src/shared"));
  git(world.root, "add", "--", "kernel/src/shared");
  git(world.root, "commit", "--quiet", "-m", "link the shared folder");
  return world;
}

test(
  "the capability qualification run accepts a tracked link to a tracked folder outside the load folders that holds no ignored file",
  async () => {
    const world = linkedSharedFolder();
    const code = await world.run();
    expect(world.lines.at(0)).toStartWith("Wrote ");
    expect(code).toBe(0);
    expect(existsSync(world.recordFile)).toBe(true);
  },
  inProcess,
);

test(
  "the capability qualification run refuses an ignored file reached through a tracked link to a tracked folder outside the load folders",
  async () => {
    const world = linkedSharedFolder();
    writeFileSync(join(world.root, "docs/shared/probe.local.ts"), "local\n");
    expect(
      readFileSync(
        join(world.root, "kernel/src/shared/probe.local.ts"),
        "utf8",
      ),
    ).toBe("local\n");
    expect(git(world.root, "status", "--porcelain")).toBe("");
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(
      world,
      "Refused: git ignores files where the run loads code (!! docs/shared/probe.local.ts); a capability qualification run loads committed files only. Repair: remove those files, then rerun.",
    );
  },
  inProcess,
);

test(
  "the capability qualification run refuses a tracked link that leaves the checkout",
  async () => {
    const world = checkout();
    const path = "kernel/src/addons/outside";
    symlinkSync("../../../..", join(world.root, path));
    git(world.root, "add", "--", path);
    git(world.root, "commit", "--quiet", "-m", "a link out of the checkout");
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(
      world,
      `Refused: tracked files differ from their committed bytes (${path} (resolves outside the tracked tree)); ${committedBytes} Repair: restore or commit them, then rerun.`,
    );
  },
  inProcess,
);

const outsideTrackedTree = (path: string) =>
  `Refused: tracked files differ from their committed bytes (${path} (resolves outside the tracked tree)); ${committedBytes} Repair: restore or commit them, then rerun.`;

test(
  "the capability qualification run refuses a tracked case-file link that reaches another checkout through a linked folder",
  async () => {
    const world = checkout();
    const committed = `${registered("K02.a-kill-after-effect-two-later-changes", "")}\n`;
    commitIn(world.root, "a case file, with installed packages ignored", {
      ".gitignore": "node_modules/\n",
      "tests/kernel/state/real.test.ts": committed,
    });
    const other = join(world.base, "other-checkout");
    mkdirSync(join(other, "a", "b"), { recursive: true });
    mkdirSync(join(other, "tests/kernel/state"), { recursive: true });
    writeFileSync(
      join(other, "tests/kernel/state/real.test.ts"),
      `${committed}// another checkout's bytes\n`,
    );
    mkdirSync(join(world.root, "node_modules"));
    symlinkSync(
      join(other, "a", "b"),
      join(world.root, "node_modules/linked-cases"),
    );
    const path = "tests/kernel/state/linked.test.ts";
    const text =
      "../../../node_modules/linked-cases/../../tests/kernel/state/real.test.ts";
    expect(resolve(dirname(join(world.root, path)), text)).toBe(
      join(world.root, "tests/kernel/state/real.test.ts"),
    );
    symlinkSync(text, join(world.root, path));
    expect(realpathSync(join(world.root, path))).toBe(
      realpathSync(join(other, "tests/kernel/state/real.test.ts")),
    );
    git(world.root, "add", "--", path);
    git(world.root, "commit", "--quiet", "-m", "a case file through a link");
    expect(git(world.root, "status", "--porcelain")).toBe("");
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(world, outsideTrackedTree(path));
  },
  inProcess,
);

test(
  "the capability qualification run refuses a tracked link to a file git does not track",
  async () => {
    const world = checkout();
    commitIn(world.root, "ignore local files", {
      ".gitignore": "local-only.ts\n",
    });
    writeFileSync(join(world.root, "local-only.ts"), "local\n");
    const path = "kernel/src/addons/to-local";
    symlinkSync("../../../local-only.ts", join(world.root, path));
    git(world.root, "add", "--", path);
    git(world.root, "commit", "--quiet", "-m", "a link to an untracked file");
    expect(git(world.root, "status", "--porcelain")).toBe("");
    expect(await world.run()).toBe(1);
    refusedWithoutRecord(world, outsideTrackedTree(path));
  },
  inProcess,
);

test(
  "the capability qualification run accepts a tracked link to a tracked name that begins with two dots",
  async () => {
    const world = checkout();
    commitIn(world.root, "a file in a folder named with two dots", {
      "..cache/file.ts": "cached\n",
    });
    symlinkSync(
      "../../../..cache/file.ts",
      join(world.root, "kernel/src/addons/cached"),
    );
    git(world.root, "add", "--", "kernel/src/addons/cached");
    git(world.root, "commit", "--quiet", "-m", "a link into the folder");
    expect(await world.run()).toBe(0);
    expect(existsSync(world.recordFile)).toBe(true);
  },
  inProcess,
);
