import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Refusal } from "agent-cli-kernel/addons/state";
import {
  helperContract,
  stateRoot,
} from "../../../skills/verify-cli/helper/cli.ts";
import {
  blockedEnding,
  fileSeen,
  keptStep,
  observedOf,
  stepArgs,
} from "../../../skills/verify-cli/helper/drive.ts";
import { launchRefusal } from "../../../skills/verify-cli/helper/launch.ts";
import { readJsonFile } from "../../../skills/verify-cli/helper/json.ts";
import {
  refusalOf,
  unfinishedChange,
} from "../../../skills/verify-cli/helper/outcome.ts";
import {
  indexText,
  readIndex,
  repositoryRoot,
  runPlace,
  runRowOf,
  sha256,
  stepRowOf,
} from "../../../skills/verify-cli/helper/place.ts";
import {
  placedStep,
  readScenario,
  scenarioBytesLimit,
} from "../../../skills/verify-cli/helper/scenario.ts";
import type { ScenarioStep } from "../../../skills/verify-cli/helper/scenario.ts";
import {
  contractUnmet,
  creditOf,
  resultAt,
  stepFile,
  unmetOf,
} from "../../../skills/verify-cli/helper/verdict.ts";
import {
  field,
  fixture,
  pinnedCommit,
  readOnlyScenario,
  releaseWorlds,
  runFolder,
  scenarioFile,
  watchdog,
  world,
} from "./harness.ts";
import type { World } from "./harness.ts";

afterAll(releaseWorlds);

describe("the helper's commands, run in process", () => {
  test(
    "each command returns its success through the kernel's in-process runner",
    async () => {
      const at = world();
      const run = runFolder(at, "r1");
      const cause = async (argv: readonly string[]) => {
        const ran = await helperContract(at.env, argv).inProcess();
        if (ran.kind !== "envelope")
          throw new Error(`Expected an envelope, got ${ran.kind}.`);
        return ran.envelope.result.causeCode;
      };
      expect(await cause(["ready", at.example])).toBe("SUCCESS_UNCHANGED");
      expect(await cause(["probe", at.example])).toBe("SUCCESS_UNCHANGED");
      expect(await cause(["sweep", at.example])).toBe("SUCCESS_UNCHANGED");
      expect(await cause(["findings", at.example])).toBe("SUCCESS_UNCHANGED");
      expect(await cause(["launch", run, at.example])).toBe(
        "SUCCESS_COMPLETED",
      );
      expect(
        await cause(["drive", run, scenarioFile(at, readOnlyScenario)]),
      ).toBe("SUCCESS_COMPLETED");
      expect(await cause(["report", run])).toBe("SUCCESS_UNCHANGED");
      expect(await cause(["pending", run])).toBe("SUCCESS_UNCHANGED");
      expect(await cause(["cleanup", run])).toBe("SUCCESS_COMPLETED");
    },
    watchdog(9),
  );

  test("the state root is the run's own state folder for a command on a run, and a relative name the state add-on never opens otherwise", () => {
    expect(stateRoot(["drive", "/runs/r1", "/s.json"])).toBe("/runs/r1/state");
    expect(stateRoot(["pending", "--json", "/runs/r1"])).toBe("/runs/r1/state");
    expect(stateRoot(["ready", "/t.ts"])).toBe("verify-cli-names-no-run");
    expect(stateRoot(["cleanup", "relative"])).toBe("verify-cli-names-no-run");
    expect(stateRoot([])).toBe("verify-cli-names-no-run");
  });
});

function scenarioWith(at: World, value: unknown) {
  return readScenario(scenarioFile(at, value));
}

function stepsOf(count: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    name: `s${String(index)}`,
    argv: ["list"],
    expect: { exitCode: 0, stderr: "" },
    ...extra,
  }));
}

function brokenRule(read: ReturnType<typeof readScenario>): string | null {
  return read.kind === "broken" ? read.rule : null;
}

describe("the bounds of a scenario, on both sides", () => {
  const base = { schema: "verify-scenario/1", feature: "f" };

  test("a name may be 64 characters, and not 65", () => {
    const at = world();
    expect(
      brokenRule(
        scenarioWith(at, {
          ...base,
          feature: "a".repeat(64),
          steps: stepsOf(1),
        }),
      ),
    ).toBeNull();
    expect(
      brokenRule(
        scenarioWith(at, {
          ...base,
          feature: "a".repeat(65),
          steps: stepsOf(1),
        }),
      ),
    ).toBe("bad-name");
  });

  test("a scenario may have 1 to 200 steps", () => {
    const at = world();
    expect(
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: stepsOf(200, { timeoutMilliseconds: 1 }),
        }),
      ),
    ).toBeNull();
    expect(
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: stepsOf(201, { timeoutMilliseconds: 1 }),
        }),
      ),
    ).toBe("step-count");
    expect(
      brokenRule(scenarioWith(at, { ...base, steps: stepsOf(1) })),
    ).toBeNull();
    expect(brokenRule(scenarioWith(at, { ...base, steps: [] }))).toBe(
      "step-count",
    );
  });

  test("a step's time limit is 1 to 600,000 ms, and its output limit 1 to 8,388,608 bytes", () => {
    const at = world();
    const rule = (extra: Record<string, unknown>) =>
      brokenRule(scenarioWith(at, { ...base, steps: stepsOf(1, extra) }));
    expect(rule({ timeoutMilliseconds: 1 })).toBeNull();
    expect(rule({ timeoutMilliseconds: 0 })).toBe("limit-out-of-range");
    expect(rule({ timeoutMilliseconds: 600_000 })).toBeNull();
    expect(rule({ timeoutMilliseconds: 600_001 })).toBe("limit-out-of-range");
    expect(rule({ outputLimitBytes: 1 })).toBeNull();
    expect(rule({ outputLimitBytes: 0 })).toBe("limit-out-of-range");
    expect(rule({ outputLimitBytes: 8_388_608 })).toBeNull();
    expect(rule({ outputLimitBytes: 8_388_609 })).toBe("limit-out-of-range");
  });

  test("the steps' time limits may sum to 3,600,000 ms, and not past it", () => {
    const at = world();
    const steps = stepsOf(6, { timeoutMilliseconds: 600_000 });
    expect(brokenRule(scenarioWith(at, { ...base, steps }))).toBeNull();
    expect(
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: [
            ...steps,
            { ...stepsOf(1)[0], name: "last", timeoutMilliseconds: 1 },
          ],
        }),
      ),
    ).toBe("limit-out-of-range");
  });

  test("a scenario file may be 1,048,576 bytes, and not one more", () => {
    const at = world();
    const text = JSON.stringify({ ...base, steps: stepsOf(1) });
    const exact = join(at.folder, "exact.json");
    writeFileSync(exact, text + " ".repeat(scenarioBytesLimit - text.length));
    expect(brokenRule(readScenario(exact))).toBeNull();
    writeFileSync(
      exact,
      text + " ".repeat(scenarioBytesLimit - text.length + 1),
    );
    expect(brokenRule(readScenario(exact))).toBe("unreadable");
    writeFileSync(exact, "{ not json");
    expect(brokenRule(readScenario(exact))).toBe("unreadable");
  });

  test("a step needs more than an exit code, and its files stay under the scratch folder", () => {
    const at = world();
    const rule = (expectation: Record<string, unknown>) =>
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: [{ name: "s", argv: [], expect: expectation }],
        }),
      );
    expect(rule({ exitCode: 0, timedOut: true })).toBe("exit-code-only");
    expect(rule({ stdout: "" })).toBe("exit-code-only");
    expect(
      rule({ exitCode: 0, files: [{ path: "{scratch}/a", content: "" }] }),
    ).toBeNull();
    expect(
      rule({ exitCode: 0, files: [{ path: "/tmp/a", absent: true }] }),
    ).toBe("path-outside-scratch");
    expect(
      rule({
        exitCode: 0,
        files: [{ path: "{scratch}/a/../../b", absent: true }],
      }),
    ).toBe("path-outside-scratch");
    expect(rule({ exitCode: 0, files: [{ path: "{scratch}/a" }] })).toBe(
      "bad-value",
    );
  });

  test("placeholders become the scratch folder and the repository in every string of argv and expect", () => {
    const step: ScenarioStep = {
      name: "s",
      runner: "bun",
      argv: ["{repository}/x", "{scratch}/y", "{other}"],
      timeoutMilliseconds: 1,
      outputLimitBytes: 1,
      expect: {
        exitCode: 0,
        stdout: "{scratch}",
        stderr: "{repository}",
        result: { "data.path": "{scratch}/z", "data.list": ["{repository}"] },
        files: [{ path: "{scratch}/f", content: "{scratch}" }],
        stdoutIncludes: ["{scratch}"],
        stderrIncludes: ["{repository}"],
      },
    };
    expect(placedStep(step, { scratch: "/s", repository: "/r" })).toEqual({
      ...step,
      argv: ["/r/x", "/s/y", "{other}"],
      expect: {
        exitCode: 0,
        stdout: "/s",
        stderr: "/r",
        result: { "data.path": "/s/z", "data.list": ["/r"] },
        files: [{ path: "/s/f", content: "{scratch}" }],
        stdoutIncludes: ["/s"],
        stderrIncludes: ["/r"],
      },
    });
  });
});

describe("how a step is judged", () => {
  const step = (
    expect: ScenarioStep["expect"],
    runner: "target" | "bun" = "target",
    argv = ["show", "--json"],
  ): ScenarioStep => ({
    name: "s",
    runner,
    argv,
    timeoutMilliseconds: 1,
    outputLimitBytes: 1,
    expect,
  });
  const envelopeLine = (
    exitCode: number,
    extra: Record<string, unknown> = {},
  ) =>
    `${JSON.stringify({ contractVersion: "3.0.0", result: { exitCode, commandIdentity: "a.show", causeCode: "SUCCESS_UNCHANGED", data: { list: [1, 2] }, ...extra } })}\n`;
  const observed = (stdout: string, extra: Record<string, unknown> = {}) => ({
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
    terminationConfirmed: true,
    stdout,
    stderr: "",
    ...extra,
  });

  test("each expectation that does not hold is listed by its name", () => {
    const expectation = {
      exitCode: 1,
      stdout: "other",
      stderr: "x",
      result: { causeCode: "OTHER", "data.list.length": 2 },
      files: [
        { path: "/a", content: "a" },
        { path: "/b", absent: true as const },
      ],
    };
    expect(
      unmetOf(
        step(expectation, "bun"),
        observed(envelopeLine(0), { outputTruncated: true, timedOut: true }),
        [{ content: "b" }, { content: "here" }],
      ),
    ).toEqual([
      "exitCode",
      "timedOut",
      "outputTruncated",
      "stdout",
      "stderr",
      "result.causeCode",
      "files.0",
      "files.1",
    ]);
    expect(
      unmetOf(
        step(
          { exitCode: 0, stdoutIncludes: ["a", "zz"], stderrIncludes: ["q"] },
          "bun",
        ),
        observed("abc"),
        [],
      ),
    ).toEqual(["stdoutIncludes.1", "stderrIncludes.0"]);
  });

  test("a time-out expected is met, and one not expected is unmet", () => {
    expect(
      unmetOf(
        step({ exitCode: 143, timedOut: true, stdout: "" }, "bun"),
        observed("", { exitCode: 143, timedOut: true }),
        [],
      ),
    ).toEqual([]);
    expect(
      unmetOf(
        step({ exitCode: 143, stdout: "" }, "bun"),
        observed("", { exitCode: 143, timedOut: true }),
        [],
      ),
    ).toEqual(["timedOut"]);
  });

  test("a dotted result path reads into the result, and length counts a list", () => {
    const result = { data: { list: [1, 2], name: "x" } };
    expect(resultAt(result, "data.list.length")).toBe(2);
    expect(resultAt(result, "data.name")).toBe("x");
    expect(resultAt(result, "data.name.length")).toBeUndefined();
    expect(resultAt(result, "data.list.1")).toBe(2);
  });

  test("the kernel's promises are checked on a target step that ended by itself", () => {
    expect(
      contractUnmet(
        step({ exitCode: 0, stderr: "" }),
        observed(envelopeLine(3)),
      ),
    ).toEqual(["contract.envelope-exit-code"]);
    expect(
      contractUnmet(
        step({ exitCode: 0, stderr: "" }),
        observed("", { stderr: "x" }),
      ),
    ).toEqual(["contract.json-one-envelope", "contract.json-stderr-empty"]);
    expect(
      contractUnmet(
        step({ exitCode: 3, stderr: "" }, "target", ["show"]),
        observed("leak", { exitCode: 3 }),
      ),
    ).toEqual(["contract.failure-stdout-empty"]);
    expect(
      contractUnmet(step({ exitCode: 0, stderr: "" }, "bun"), observed("")),
    ).toEqual([]);
    expect(
      contractUnmet(
        step({ exitCode: 0, stderr: "" }),
        observed("", { timedOut: true }),
      ),
    ).toEqual([]);
    expect(
      contractUnmet(
        step({ exitCode: 0, stderr: "" }, "target", ["show", "--", "--json"]),
        observed("", { exitCode: 0 }),
      ),
    ).toEqual([]);
  });

  test("only a target step's envelope credits a station", () => {
    expect(
      creditOf(step({ exitCode: 0, stderr: "" }), envelopeLine(0)),
    ).toEqual({
      commandIdentity: "a.show",
      causeCode: "SUCCESS_UNCHANGED",
    });
    expect(
      creditOf(step({ exitCode: 0, stderr: "" }, "bun"), envelopeLine(0)),
    ).toEqual({
      commandIdentity: null,
      causeCode: null,
    });
    expect(creditOf(step({ exitCode: 0, stderr: "" }), "plain\n")).toEqual({
      commandIdentity: null,
      causeCode: null,
    });
  });

  test("a step's file keeps the result keys it expected in place of stdout", () => {
    const kept = stepFile(
      "f",
      step({ exitCode: 0, result: { "data.list.length": 2, missing: 1 } }),
      observed(envelopeLine(0)),
      [],
    );
    expect(field(kept, "observed", "result")).toEqual({
      "data.list.length": 2,
      missing: null,
    });
    expect(field(kept, "observed", "stdout")).toBeUndefined();
    expect(field(kept, "verdict")).toBe("unmet");
    const plain = stepFile(
      "f",
      step({ exitCode: 0, stdout: "hi" }, "bun"),
      observed("hi"),
      [],
    );
    expect(field(plain, "observed", "stdout")).toBe("hi");
    expect(field(plain, "verdict")).toBe("met");
  });
});

describe("the run's folder and its index", () => {
  const row = {
    schema: "verify-index/1",
    row: "run",
    repository: "/r",
    target: "src/cli.ts",
    pinnedCommit,
    bun: "1.4.4",
    platform: "darwin arm64",
    headCommit: null,
    uncommittedPaths: null,
  } as const;

  test("an index reads as missing, read, or unreadable with its reason", () => {
    const at = world();
    const place = runPlace(runFolder(at, "r1"));
    expect(readIndex(place)).toEqual({ kind: "missing" });
    mkdirSync(place.evidence, { recursive: true });
    writeFileSync(place.index, indexText([row]));
    expect(readIndex(place)).toEqual({ kind: "read", run: row, steps: [] });
    writeFileSync(place.index, `${indexText([row])}{"row":"step"}\n`);
    expect(readIndex(place)).toEqual({
      kind: "unreadable",
      reason: `line 2 of ${place.index} is not a step row`,
    });
    writeFileSync(place.index, JSON.stringify(row));
    expect(readIndex(place)).toEqual({
      kind: "unreadable",
      reason: `${place.index} does not end with a line feed`,
    });
    writeFileSync(
      place.index,
      `${JSON.stringify({ ...row, schema: "other" })}\n`,
    );
    expect(readIndex(place)).toEqual({
      kind: "unreadable",
      reason: `${place.index} does not start with a run row`,
    });
  });

  test("a run row needs its nine fields, and its two git facts may be null", () => {
    expect(runRowOf(row)).toEqual(row);
    expect(
      runRowOf({ ...row, headCommit: "abc", uncommittedPaths: 3 }),
    ).toMatchObject({ uncommittedPaths: 3 });
    expect(runRowOf({ ...row, uncommittedPaths: 1.5 })).toBeUndefined();
    expect(runRowOf({ ...row, bun: undefined })).toBeUndefined();
  });

  test("the repository root is the nearest folder at or above the target that holds a package.json", () => {
    const at = world();
    expect(repositoryRoot(at.example)).toBe(at.repo);
    expect(repositoryRoot(join(at.repo, "src", "deep", "x.ts"))).toBe(at.repo);
    expect(repositoryRoot("/x.ts")).toBeUndefined();
  });

  test("a JSON file reads as missing, read, or unreadable with its reason", () => {
    const at = world();
    const path = join(at.folder, "file.json");
    expect(readJsonFile(path)).toEqual({ kind: "missing" });
    writeFileSync(path, '{"a":1}');
    expect(readJsonFile(path)).toEqual({ kind: "read", value: { a: 1 } });
    writeFileSync(path, "{");
    expect(readJsonFile(path).kind).toBe("unreadable");
    expect(readJsonFile(at.folder).kind).toBe("unreadable");
  });
});

describe("how the state add-on's outcomes map to the helper's causes", () => {
  test("each state refusal maps to its station, and a run that ran maps to none", () => {
    const cases: readonly [
      Refusal | { readonly kind: "ran" },
      string | undefined,
    ][] = [
      [{ kind: "ran" }, undefined],
      [{ kind: "held-lock", operationId: "op" }, "DOMAIN_VERIFY_RUN_HELD"],
      [
        { kind: "unresolved-case", operationId: "op" },
        "DOMAIN_VERIFY_RUN_UNRESOLVED",
      ],
      [
        { kind: "unavailable", reason: "store-publication" },
        "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      ],
      [{ kind: "busy" }, "DOMAIN_VERIFY_STATE_UNAVAILABLE"],
    ];
    for (const [outcome, cause] of cases)
      expect(String(refusalOf(outcome, "/r")?.causeCode)).toBe(String(cause));
  });

  test("an unfinished change maps to CHANGE_UNCHANGED before any effect, and to CHANGE_UNKNOWN after one", () => {
    expect(unfinishedChange("unchanged", "before", "after")).toEqual({
      causeCode: "DOMAIN_VERIFY_CHANGE_UNCHANGED",
      message: "before",
    });
    expect(unfinishedChange("unknown", "before", "after")).toEqual({
      causeCode: "DOMAIN_VERIFY_CHANGE_UNKNOWN",
      message: "after",
    });
  });
});

describe("how drive runs and keeps a step", () => {
  const step: ScenarioStep = {
    name: "s",
    runner: "target",
    argv: ["show", "--json"],
    timeoutMilliseconds: 1,
    outputLimitBytes: 1,
    expect: { exitCode: 0, stdout: "out" },
  };
  const ran = {
    stdout: "out",
    stderr: "",
    exitCode: 0,
    terminationConfirmed: false,
    outputTruncated: false,
  };

  test("a target step runs Bun on the bound entry file, and a Bun step passes its words to Bun alone", () => {
    const run = runRowOf({
      schema: "verify-index/1",
      row: "run",
      repository: "/r",
      target: "src/cli.ts",
      pinnedCommit,
      bun: "1.4.4",
      platform: "p",
      headCommit: null,
      uncommittedPaths: null,
    });
    if (run === undefined) throw new Error("The run row did not read.");
    expect(stepArgs(step, run)).toEqual([
      "--no-install",
      "/r/src/cli.ts",
      "show",
      "--json",
    ]);
    expect(stepArgs({ ...step, runner: "bun" }, run)).toEqual([
      "show",
      "--json",
    ]);
  });

  test("what a step observed comes from the program's result, and a result with no details did not time out", () => {
    expect(observedOf(ran)).toEqual({ ...ran, timedOut: false });
  });

  test("a file a step expects reads as its content, or as absent", async () => {
    const at = world();
    const path = join(at.folder, "seen.txt");
    expect(await fileSeen(path)).toEqual({ content: null });
    writeFileSync(path, "here");
    expect(await fileSeen(path)).toEqual({ content: "here" });
    const folderRead = await fileSeen(at.folder).catch((error: unknown) =>
      field(error, "code"),
    );
    expect(folderRead).toBe("EISDIR");
  });

  test("a kept step's index row names its file and the SHA-256 of its content", async () => {
    const at = world();
    const place = runPlace(runFolder(at, "r1"));
    const kept = await keptStep(place, "f", step, ran);
    expect(kept.row).toEqual({
      row: "step",
      feature: "f",
      step: "s",
      runner: "target",
      verdict: "unmet",
      commandIdentity: null,
      causeCode: null,
      exitCode: 0,
      file: join("f", "s.json"),
      sha256: sha256(kept.content),
    });
    expect(stepRowOf(JSON.parse(indexText([kept.row])))).toEqual(kept.row);
    expect(stepRowOf({ ...kept.row, verdict: "maybe" })).toBeUndefined();
  });

  test("a feature already driven, or a scratch folder already removed, ends the drive before any step", () => {
    const where = { run: "/r", feature: "f", scratch: "/r/scratch" };
    expect(blockedEnding("driven", where)?.causeCode).toBe(
      "DOMAIN_VERIFY_ALREADY_DRIVEN",
    );
    expect(blockedEnding("clean", where)?.causeCode).toBe(
      "DOMAIN_VERIFY_RUN_CLEAN",
    );
    expect(blockedEnding(undefined, where)).toBeUndefined();
  });
});

describe("what launch refuses before it makes anything", () => {
  test("launch admits a free folder for a pinned target, and names each refusal", () => {
    const at = world();
    const run = runFolder(at, "r1");
    expect(launchRefusal(run, at.example)).toEqual({
      kind: "admitted",
      root: at.repo,
      pinnedCommit,
    });
    expect(launchRefusal(run, join(at.repo, "gone.ts"))).toMatchObject({
      causeCode: "DOMAIN_VERIFY_TARGET_MISSING",
    });
    expect(launchRefusal(at.repo, at.example)).toMatchObject({
      causeCode: "DOMAIN_VERIFY_RUN_EXISTS",
    });
    expect(launchRefusal(run, fixture(at, "../../gone.ts"))).toMatchObject({
      causeCode: "DOMAIN_VERIFY_TARGET_MISSING",
    });
  });
});
