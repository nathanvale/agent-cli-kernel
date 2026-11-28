import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProgramRequest } from "agent-cli-kernel";
import type { Refusal } from "agent-cli-kernel/addons/state";
import { readRootedFile } from "../../../kernel/src/shared/rooted-file.ts";
import {
  helperContract,
  stateRoot,
} from "../../../skills/verify-cli/helper/cli.ts";
import {
  blockedEnding,
  fileReadLimit,
  fileSeen,
  keptStep,
  stepRunOf,
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
  verificationRun,
  runRowOf,
  stepRowOf,
} from "../../../skills/verify-cli/helper/place.ts";
import {
  placedStep,
  readScenario,
  scenarioOf,
} from "../../../skills/verify-cli/helper/scenario.ts";
import type { ScenarioStep } from "../../../skills/verify-cli/helper/scenario.ts";
import type { FileKind } from "../../../skills/verify-cli/helper/verdict.ts";
import {
  contractUnmet,
  stationOf,
  resultAt,
  stepFile,
  unmetOf,
} from "../../../skills/verify-cli/helper/verdict.ts";
import { targetRunner } from "../../../skills/verify-cli/helper/target.ts";
import {
  field,
  fixture,
  lsTree,
  makeFifo,
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

  test(
    "each command's refusals come back through the kernel's in-process runner",
    async () => {
      const at = world();
      const never = runFolder(at, "never");
      const cause = async (argv: readonly string[]) => {
        const ran = await helperContract(at.env, argv).inProcess();
        if (ran.kind !== "envelope")
          throw new Error(`Expected an envelope, got ${ran.kind}.`);
        return [ran.exitCode, ran.envelope.result.causeCode];
      };
      expect(await cause(["ready", fixture(at, "throwing-cli.ts")])).toEqual([
        3,
        "DOMAIN_VERIFY_TARGET_START",
      ]);
      expect(await cause(["launch", at.repo, at.example])).toEqual([
        3,
        "DOMAIN_VERIFY_RUN_EXISTS",
      ]);
      for (const name of ["report", "cleanup", "pending"])
        expect(await cause([name, never])).toEqual([
          3,
          "DOMAIN_VERIFY_RUN_MISSING",
        ]);
      expect(
        await cause(["drive", never, scenarioFile(at, readOnlyScenario)]),
      ).toEqual([3, "DOMAIN_VERIFY_RUN_MISSING"]);
      expect(lsTree(never)).toEqual([]);
    },
    watchdog(6),
  );

  test(
    "report lists a process end that was not confirmed",
    async () => {
      const at = world();
      const run = runFolder(at, "r1");
      const inProcess = (argv: readonly string[]) =>
        helperContract(at.env, argv).inProcess();
      const launched = await inProcess(["launch", run, at.example]);
      expect(launched.kind).toBe("envelope");
      const place = verificationRun(run);
      mkdirSync(join(place.evidence, "f"));
      const content = `${JSON.stringify({
        schema: "verify-step/1",
        unmet: [],
        observed: { terminationConfirmed: false },
      })}\n`;
      writeFileSync(join(place.evidence, "f", "lingered.json"), content);
      const row = {
        row: "step",
        feature: "f",
        step: "lingered",
        runner: "target",
        verdict: "met",
        commandIdentity: null,
        causeCode: null,
        exitCode: 0,
        file: "f/lingered.json",
        sha256: "0".repeat(64),
      } as const;
      writeFileSync(place.index, indexText([row]), { flag: "a" });
      const reported = await inProcess(["report", run]);
      if (reported.kind !== "envelope")
        throw new Error(`Expected an envelope, got ${reported.kind}.`);
      expect(field(reported.envelope.result, "data", "unconfirmed")).toEqual([
        "f/lingered",
      ]);
    },
    watchdog(2),
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
    writeFileSync(exact, text + " ".repeat(1_048_576 - text.length));
    expect(brokenRule(readScenario(exact))).toBeNull();
    writeFileSync(exact, text + " ".repeat(1_048_577 - text.length));
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
    expect(
      rule({
        exitCode: 0,
        files: [{ path: "{scratch}-other/x", absent: true }],
      }),
    ).toBe("path-outside-scratch");
    expect(rule({ exitCode: 0, files: [{ path: "{scratch}/a" }] })).toBe(
      "bad-value",
    );
  });

  test("a field of the wrong type is a bad value", () => {
    const at = world();
    const rule = (step: Record<string, unknown>) =>
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: [
            {
              name: "s",
              argv: [],
              expect: { exitCode: 0, stdout: "" },
              ...step,
            },
          ],
        }),
      );
    expect(rule({ expect: "x" })).toBe("bad-value");
    expect(rule({ argv: [1] })).toBe("bad-value");
    expect(rule({ expect: { exitCode: 0, stdout: 1 } })).toBe("bad-value");
    expect(rule({ timeoutMilliseconds: 1.5 })).toBe("bad-value");
    expect(rule({ expect: { exitCode: 0.5, stdout: "" } })).toBe("bad-value");
    expect(rule({ expect: { exitCode: 0, stdout: "", timedOut: "yes" } })).toBe(
      "bad-value",
    );
    expect(rule({ runner: "node" })).toBe("bad-value");
    expect(
      rule({
        expect: {
          exitCode: 0,
          files: [{ path: "{scratch}/a", content: "", absent: true }],
        },
      }),
    ).toBe("bad-value");
    expect(
      brokenRule(
        scenarioWith(at, {
          ...base,
          schema: "verify-scenario/2",
          steps: stepsOf(1),
        }),
      ),
    ).toBe("unknown-field");
  });

  test("an empty result, file list or includes list is no expectation", () => {
    const at = world();
    const rule = (expectation: Record<string, unknown>, runner = "target") =>
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: [{ name: "s", runner, argv: [], expect: expectation }],
        }),
      );
    expect(rule({ exitCode: 0, result: {} })).toBe("exit-code-only");
    expect(rule({ exitCode: 0, files: [] })).toBe("exit-code-only");
    expect(rule({ exitCode: 0, stdoutIncludes: [] }, "bun")).toBe(
      "exit-code-only",
    );
    expect(rule({ exitCode: 0, stderrIncludes: [] }, "bun")).toBe(
      "exit-code-only",
    );
    expect(rule({ exitCode: 0, result: { causeCode: "X" } })).toBeNull();
    expect(rule({ exitCode: 0, stdoutIncludes: ["x"] }, "bun")).toBeNull();
  });

  test("an empty string in an includes list observes nothing and is refused", () => {
    const at = world();
    const rule = (expectation: Record<string, unknown>) =>
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: [{ name: "s", runner: "bun", argv: [], expect: expectation }],
        }),
      );
    expect(rule({ exitCode: 0, stdoutIncludes: [""] })).toBe("bad-value");
    expect(rule({ exitCode: 0, stderrIncludes: ["x", ""] })).toBe("bad-value");
  });

  test("a word of argv that holds a NUL is refused before anything runs", () => {
    const at = world();
    expect(
      brokenRule(
        scenarioWith(at, {
          ...base,
          steps: [
            {
              name: "s",
              argv: ["show", "ma\u0000rs"],
              expect: { exitCode: 0, stderr: "" },
            },
          ],
        }),
      ),
    ).toBe("bad-value");
  });

  test("a scenario is read once, as frozen data", () => {
    let reads = 0;
    const expectation = { exitCode: 0, stdout: "" };
    Object.defineProperty(expectation, "stdoutIncludes", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? undefined : [];
      },
    });
    expect(() =>
      scenarioOf({
        ...base,
        steps: [{ name: "s", argv: [], expect: expectation }],
      }),
    ).not.toThrow();
    expect(reads).toBe(1);
    const at = world();
    const read = scenarioWith(at, { ...base, steps: stepsOf(1) });
    expect(
      read.kind === "read" && Object.isFrozen(read.scenario.steps[0]?.expect),
    ).toBe(true);
  });

  test("a scenario path that is missing, a folder, or not JSON names which", () => {
    const at = world();
    const detail = (path: string) => {
      const read = readScenario(path);
      return read.kind === "broken" ? `${read.rule}: ${read.detail}` : "read";
    };
    expect(detail(join(at.folder, "none.json"))).toBe(
      `unreadable: ${join(at.folder, "none.json")} is missing`,
    );
    expect(detail(at.folder)).toBe(
      `unreadable: ${at.folder} is not a regular file`,
    );
    writeFileSync(join(at.folder, "bad.json"), "{");
    expect(detail(join(at.folder, "bad.json"))).toBe(
      `unreadable: ${join(at.folder, "bad.json")} is not JSON`,
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
        files: [{ path: "/s/f", content: "/s" }],
        stdoutIncludes: ["/s"],
        stderrIncludes: ["/r"],
      },
    });
  });

  test("a placeholder's folder is put in as it is, dollar signs and all", () => {
    const step: ScenarioStep = {
      name: "s",
      runner: "bun",
      argv: ["{scratch}/out", "{repository}"],
      timeoutMilliseconds: 1,
      outputLimitBytes: 1,
      expect: { exitCode: 0, stdout: "{scratch}" },
    };
    const places = { scratch: "/runs/pay$$roll$&$`$'", repository: "/r$1" };
    expect(placedStep(step, places)).toEqual({
      ...step,
      argv: ["/runs/pay$$roll$&$`$'/out", "/r$1"],
      expect: { exitCode: 0, stdout: "/runs/pay$$roll$&$`$'" },
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
        [
          { kind: "file", content: "b" },
          { kind: "file", content: "here" },
        ],
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
        observed('{"contractVersion":"3.0.0","result":{"exitCode":0}}\n'),
      ),
    ).toEqual(["contract.json-one-envelope"]);
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
      stationOf(step({ exitCode: 0, stderr: "" }), envelopeLine(0)),
    ).toEqual({
      commandIdentity: "a.show",
      causeCode: "SUCCESS_UNCHANGED",
    });
    expect(
      stationOf(step({ exitCode: 0, stderr: "" }, "bun"), envelopeLine(0)),
    ).toEqual({
      commandIdentity: null,
      causeCode: null,
    });
    expect(stationOf(step({ exitCode: 0, stderr: "" }), "plain\n")).toEqual({
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
    const place = verificationRun(runFolder(at, "r1"));
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

  test("an index must be a regular file of at most 16,777,216 bytes", () => {
    const at = world();
    const place = verificationRun(runFolder(at, "r1"));
    mkdirSync(place.evidence, { recursive: true });
    const first = indexText([row]);
    writeFileSync(
      place.index,
      first + " ".repeat(16_777_216 - first.length - 1) + "\n",
    );
    expect(readIndex(place)).toEqual({
      kind: "unreadable",
      reason: `line 2 of ${place.index} is not a step row`,
    });
    writeFileSync(place.index, first);
    expect(readIndex(place).kind).toBe("read");
    writeFileSync(place.index, first + "x".repeat(16_777_217 - first.length));
    expect(readIndex(place)).toEqual({
      kind: "unreadable",
      reason: `${place.index} is 16777217 bytes, over 16777216`,
    });
    rmSync(place.index);
    mkdirSync(place.index);
    expect(readIndex(place)).toEqual({
      kind: "unreadable",
      reason: `${place.index} is not a regular file`,
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
    expect(stepRunOf(ran)).toEqual({ ...ran, timedOut: false });
  });

  test("a file a step expects reads as its content, or as what stood there instead", async () => {
    const at = world();
    const path = join(at.folder, "seen.txt");
    expect(await fileSeen(path)).toEqual({ kind: "absent", content: null });
    expect(await fileSeen(join(path, "below"))).toEqual({
      kind: "absent",
      content: null,
    });
    writeFileSync(path, "here");
    expect(await fileSeen(path)).toEqual({ kind: "file", content: "here" });
    expect(await fileSeen(join(path, "below"))).toEqual({
      kind: "absent",
      content: null,
    });
    expect(await fileSeen(at.folder)).toEqual({
      kind: "folder",
      content: null,
    });
    const pipe = join(at.folder, "pipe");
    await makeFifo(pipe);
    expect(await fileSeen(pipe)).toEqual({ kind: "other", content: null });
    const large = join(at.folder, "large");
    writeFileSync(large, "x".repeat(fileReadLimit));
    expect((await fileSeen(large)).kind).toBe("file");
    writeFileSync(large, "x".repeat(fileReadLimit + 1));
    expect(await fileSeen(large)).toEqual({
      kind: "too-large",
      content: null,
    });
  });

  test(
    "drive refuses a symbolic link at the path or in a parent folder, while regular files still hold",
    async () => {
      const at = world();
      const outside = join(at.folder, "outside");
      mkdirSync(outside);
      const outsideFile = join(outside, "secret.txt");
      writeFileSync(outsideFile, "outside");

      const scratch = join(at.folder, "scratch");
      mkdirSync(scratch);
      const dangling = join(scratch, "lock");
      symlinkSync(join(scratch, "nowhere"), dangling);
      const liveLink = join(scratch, "alias.txt");
      symlinkSync(outsideFile, liveLink);
      symlinkSync(outside, join(scratch, "out"));
      const regular = join(scratch, "plain.txt");
      writeFileSync(regular, "plain");

      expect<unknown>(await fileSeen(dangling)).toEqual({
        kind: "symbolic-link",
        content: null,
      });
      expect<unknown>(await fileSeen(liveLink)).toEqual({
        kind: "symbolic-link",
        content: null,
      });
      expect<unknown>(
        await fileSeen(join(scratch, "out", "secret.txt")),
      ).toEqual({
        kind: "symbolic-link",
        content: null,
      });
      expect(await fileSeen(regular)).toEqual({
        kind: "file",
        content: "plain",
      });

      const run = runFolder(at, "r-links");
      const launched = await helperContract(at.env, [
        "launch",
        run,
        at.example,
      ]).inProcess();
      expect(launched.kind).toBe("envelope");
      const place = verificationRun(run);
      symlinkSync(join(place.scratch, "nowhere"), join(place.scratch, "lock"));
      symlinkSync(outsideFile, join(place.scratch, "alias.txt"));
      symlinkSync(outside, join(place.scratch, "out"));
      writeFileSync(join(place.scratch, "plain.txt"), "plain");

      const scenario = scenarioFile(at, {
        schema: "verify-scenario/1",
        feature: "drive-links",
        steps: [
          {
            name: "dangling-link-where-absent",
            runner: "bun",
            argv: ["-e", ""],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/lock", absent: true }],
            },
          },
          {
            name: "live-link-at-path",
            runner: "bun",
            argv: ["-e", ""],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/alias.txt", content: "outside" }],
            },
          },
          {
            name: "file-through-linked-parent",
            runner: "bun",
            argv: ["-e", ""],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/out/secret.txt", content: "outside" }],
            },
          },
          {
            name: "regular-file-holds",
            runner: "bun",
            argv: ["-e", ""],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/plain.txt", content: "plain" }],
            },
          },
        ],
      });

      const driven = await helperContract(at.env, [
        "drive",
        run,
        scenario,
      ]).inProcess();
      if (driven.kind !== "envelope")
        throw new Error(`Expected an envelope, got ${driven.kind}.`);
      expect(driven.envelope.result.causeCode).toBe(
        "DOMAIN_VERIFY_EXPECTATION_UNMET",
      );

      const readStep = (name: string): unknown =>
        JSON.parse(
          readFileSync(
            join(place.evidence, "drive-links", `${name}.json`),
            "utf8",
          ),
        );
      for (const name of [
        "dangling-link-where-absent",
        "live-link-at-path",
        "file-through-linked-parent",
      ]) {
        const kept = readStep(name);
        expect({
          verdict: field(kept, "verdict"),
          unmet: field(kept, "unmet"),
          files: field(kept, "observed", "files"),
          fileKinds: field(kept, "observed", "fileKinds"),
        }).toEqual({
          verdict: "unmet",
          unmet: ["files.0"],
          files: [null],
          fileKinds: ["symbolic-link"],
        });
      }
      const regularStep = readStep("regular-file-holds");
      expect({
        verdict: field(regularStep, "verdict"),
        unmet: field(regularStep, "unmet"),
        files: field(regularStep, "observed", "files"),
        fileKinds: field(regularStep, "observed", "fileKinds"),
      }).toEqual({
        verdict: "met",
        unmet: [],
        files: ["plain"],
        fileKinds: ["file"],
      });
    },
    watchdog(4),
  );

  test(
    "drive refuses a linked scratch folder while allowing a linked verification run folder",
    async () => {
      const at = world();
      const outside = join(at.folder, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "outside");

      const run = runFolder(at, "r-linked-scratch");
      const launched = await helperContract(at.env, [
        "launch",
        run,
        at.example,
      ]).inProcess();
      expect(launched.kind).toBe("envelope");
      const place = verificationRun(run);
      const swapScratch =
        'const fs = require("node:fs"); fs.rmSync(process.argv[1], { recursive: true, force: true }); fs.symlinkSync(process.argv[2], process.argv[1]);';

      const scenario = scenarioFile(at, {
        schema: "verify-scenario/1",
        feature: "linked-scratch",
        steps: [
          {
            name: "live-linked-scratch",
            runner: "bun",
            argv: ["-e", swapScratch, "{scratch}", outside],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/secret.txt", content: "outside" }],
            },
          },
          {
            name: "dangling-linked-scratch",
            runner: "bun",
            argv: ["-e", swapScratch, "{scratch}", join(at.folder, "nowhere")],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/lock", absent: true }],
            },
          },
        ],
      });

      const driven = await helperContract(at.env, [
        "drive",
        run,
        scenario,
      ]).inProcess();
      if (driven.kind !== "envelope")
        throw new Error(`Expected an envelope, got ${driven.kind}.`);
      expect(driven.envelope.result.causeCode).toBe(
        "DOMAIN_VERIFY_EXPECTATION_UNMET",
      );

      for (const name of ["live-linked-scratch", "dangling-linked-scratch"]) {
        const kept: unknown = JSON.parse(
          readFileSync(
            join(place.evidence, "linked-scratch", `${name}.json`),
            "utf8",
          ),
        );
        expect({
          verdict: field(kept, "verdict"),
          unmet: field(kept, "unmet"),
          files: field(kept, "observed", "files"),
          fileKinds: field(kept, "observed", "fileKinds"),
        }).toEqual({
          verdict: "unmet",
          unmet: ["files.0"],
          files: [null],
          fileKinds: ["symbolic-link"],
        });
      }

      const realRun = runFolder(at, "r-linked-run-target");
      const launchedReal = await helperContract(at.env, [
        "launch",
        realRun,
        at.example,
      ]).inProcess();
      expect(launchedReal.kind).toBe("envelope");
      writeFileSync(
        join(verificationRun(realRun).scratch, "plain.txt"),
        "plain",
      );
      const linkedRun = join(at.folder, "r-linked-run");
      symlinkSync(realRun, linkedRun);

      const linkedRunScenario = scenarioFile(at, {
        schema: "verify-scenario/1",
        feature: "linked-run-folder",
        steps: [
          {
            name: "file-under-linked-run",
            runner: "bun",
            argv: ["-e", ""],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/plain.txt", content: "plain" }],
            },
          },
        ],
      });

      const drivenLinkedRun = await helperContract(at.env, [
        "drive",
        linkedRun,
        linkedRunScenario,
      ]).inProcess();
      if (drivenLinkedRun.kind !== "envelope")
        throw new Error(`Expected an envelope, got ${drivenLinkedRun.kind}.`);
      expect(drivenLinkedRun.envelope.result.causeCode).toBe(
        "SUCCESS_COMPLETED",
      );
      const keptLinkedRun: unknown = JSON.parse(
        readFileSync(
          join(
            verificationRun(linkedRun).evidence,
            "linked-run-folder",
            "file-under-linked-run.json",
          ),
          "utf8",
        ),
      );
      expect({
        verdict: field(keptLinkedRun, "verdict"),
        unmet: field(keptLinkedRun, "unmet"),
        files: field(keptLinkedRun, "observed", "files"),
        fileKinds: field(keptLinkedRun, "observed", "fileKinds"),
      }).toEqual({
        verdict: "met",
        unmet: [],
        files: ["plain"],
        fileKinds: ["file"],
      });
    },
    watchdog(4),
  );

  test(
    "drive refuses an in-scratch or dangling linked parent folder",
    async () => {
      const at = world();
      const run = runFolder(at, "r-ancestor-links");
      const launched = await helperContract(at.env, [
        "launch",
        run,
        at.example,
      ]).inProcess();
      expect(launched.kind).toBe("envelope");
      const place = verificationRun(run);
      const sub = join(place.scratch, "sub");
      mkdirSync(sub);
      writeFileSync(join(sub, "plain.txt"), "inside");
      symlinkSync(sub, join(place.scratch, "alias-dir"));
      symlinkSync(
        join(place.scratch, "nowhere"),
        join(place.scratch, "dangling-dir"),
      );

      const scenario = scenarioFile(at, {
        schema: "verify-scenario/1",
        feature: "ancestor-links",
        steps: [
          {
            name: "in-scratch-linked-parent",
            runner: "bun",
            argv: ["-e", ""],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [
                { path: "{scratch}/alias-dir/plain.txt", content: "inside" },
              ],
            },
          },
          {
            name: "dangling-linked-parent",
            runner: "bun",
            argv: ["-e", ""],
            expect: {
              exitCode: 0,
              stderr: "",
              files: [{ path: "{scratch}/dangling-dir/lock", absent: true }],
            },
          },
        ],
      });

      const driven = await helperContract(at.env, [
        "drive",
        run,
        scenario,
      ]).inProcess();
      if (driven.kind !== "envelope")
        throw new Error(`Expected an envelope, got ${driven.kind}.`);
      expect(driven.envelope.result.causeCode).toBe(
        "DOMAIN_VERIFY_EXPECTATION_UNMET",
      );

      for (const name of [
        "in-scratch-linked-parent",
        "dangling-linked-parent",
      ]) {
        const kept: unknown = JSON.parse(
          readFileSync(
            join(place.evidence, "ancestor-links", `${name}.json`),
            "utf8",
          ),
        );
        expect({
          verdict: field(kept, "verdict"),
          unmet: field(kept, "unmet"),
          files: field(kept, "observed", "files"),
          fileKinds: field(kept, "observed", "fileKinds"),
        }).toEqual({
          verdict: "unmet",
          unmet: ["files.0"],
          files: [null],
          fileKinds: ["symbolic-link"],
        });
      }
    },
    watchdog(4),
  );

  test(
    "fileSeen refuses a parent or scratch folder swapped for a link between check and open",
    async () => {
      const at = world();
      const outside = join(at.folder, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "outside");

      const scratch = join(at.folder, "scratch-parent-swap");
      const sub = join(scratch, "sub");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "secret.txt"), "inside");

      let parentSwapped = false;
      const parentSwapResult = await fileSeen(
        join(sub, "secret.txt"),
        scratch,
        {
          beforeOpen: () => {
            parentSwapped = true;
            rmSync(sub, { recursive: true, force: true });
            symlinkSync(outside, sub);
          },
        },
      );
      expect(parentSwapped).toBe(true);
      expect(parentSwapResult).toEqual({
        kind: "symbolic-link",
        content: null,
      });

      const scratchSwap = join(at.folder, "scratch-self-swap");
      mkdirSync(scratchSwap, { recursive: true });
      writeFileSync(join(scratchSwap, "secret.txt"), "inside");

      let scratchSwapped = false;
      const scratchSwapResult = await fileSeen(
        join(scratchSwap, "secret.txt"),
        scratchSwap,
        {
          beforeOpen: () => {
            scratchSwapped = true;
            rmSync(scratchSwap, { recursive: true, force: true });
            symlinkSync(outside, scratchSwap);
          },
        },
      );
      expect(scratchSwapped).toBe(true);
      expect(scratchSwapResult).toEqual({
        kind: "symbolic-link",
        content: null,
      });
    },
    watchdog(4),
  );

  test(
    "fileSeen post-open recheck agrees with readRootedFile on replaced files and linked parents",
    async () => {
      const at = world();

      const setup = (label: string) => {
        const root = join(at.folder, label);
        const sub = join(root, "sub");
        mkdirSync(sub, { recursive: true });
        const target = join(sub, "target.txt");
        writeFileSync(target, "original");
        return { root, sub, target };
      };

      const honestA = setup("agree-honest-a");
      const honestB = setup("agree-honest-b");
      const seenHonest = await fileSeen(honestA.target, honestA.root);
      const rootedHonest = readRootedFile(
        honestB.root,
        "sub/target.txt",
        fileReadLimit,
      );
      expect(seenHonest).toEqual({ kind: "file", content: "original" });
      expect(rootedHonest.kind).toBe("read");

      const inodeA = setup("agree-inode-a");
      const replA = join(inodeA.sub, "replacement.txt");
      writeFileSync(replA, "swapped");
      const seenInode = await fileSeen(inodeA.target, inodeA.root, {
        afterOpen: () => {
          renameSync(replA, inodeA.target);
        },
      });
      const inodeB = setup("agree-inode-b");
      const replB = join(inodeB.sub, "replacement.txt");
      writeFileSync(replB, "swapped");
      const rootedInode = readRootedFile(
        inodeB.root,
        "sub/target.txt",
        fileReadLimit,
        {
          afterOpen: () => {
            renameSync(replB, inodeB.target);
          },
        },
      );
      expect(seenInode).toEqual({ kind: "symbolic-link", content: null });
      expect(rootedInode).toMatchObject({
        kind: "refused",
        reason: "outside-root",
      });

      const parentA = setup("agree-parent-a");
      const movedA = join(at.folder, "agree-moved-a");
      const seenParent = await fileSeen(parentA.target, parentA.root, {
        afterOpen: () => {
          renameSync(parentA.sub, movedA);
          symlinkSync(movedA, parentA.sub);
        },
      });
      const parentB = setup("agree-parent-b");
      const movedB = join(at.folder, "agree-moved-b");
      const rootedParent = readRootedFile(
        parentB.root,
        "sub/target.txt",
        fileReadLimit,
        {
          afterOpen: () => {
            renameSync(parentB.sub, movedB);
            symlinkSync(movedB, parentB.sub);
          },
        },
      );
      expect(seenParent).toEqual({ kind: "symbolic-link", content: null });
      expect(rootedParent).toMatchObject({
        kind: "refused",
        reason: "linked-folder",
      });
    },
    watchdog(4),
  );

  test("an expected file holds only as a file, and an absent one only when nothing stands there", () => {
    const step: ScenarioStep = {
      name: "s",
      runner: "bun",
      argv: ["-e", ""],
      timeoutMilliseconds: 1,
      outputLimitBytes: 1,
      expect: {
        exitCode: 0,
        files: [
          { path: "/x/a", absent: true },
          { path: "/x/b", content: "" },
        ],
      },
    };
    const observed = {
      exitCode: 0,
      timedOut: false,
      outputTruncated: false,
      terminationConfirmed: true,
      stdout: "",
      stderr: "",
    };
    const seen = (kind: FileKind) => ({ kind, content: null });
    expect(
      unmetOf(step, observed, [seen("absent"), { kind: "file", content: "" }]),
    ).toEqual([]);
    for (const kind of ["folder", "other", "too-large", "unreadable"] as const)
      expect(unmetOf(step, observed, [seen(kind), seen(kind)])).toEqual([
        "files.0",
        "files.1",
      ]);
  });

  test("a kept step's index row names its file and the SHA-256 of its content", async () => {
    const kept = await keptStep("f", step, ran, {
      headCommit: null,
      uncommittedPaths: null,
      gitFailure: null,
    });
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
      sha256: new Bun.CryptoHasher("sha256").update(kept.content).digest("hex"),
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

describe("how the helper runs a target", () => {
  test("a target runs as Bun on its entry file with the given words, and its streams come back whole", async () => {
    const seen: ProgramRequest[] = [];
    const programs = {
      supplied: (request: ProgramRequest) => {
        seen.push(request);
        return Promise.resolve({
          exitCode: 2,
          stdout: "out",
          stderr: "err",
          terminationConfirmed: true,
          outputTruncated: false,
        });
      },
    };
    const bun = helperContract({}, []).contract.boundary.path("/bun");
    const runTarget = targetRunner(programs, bun, "/r/cli.ts");
    expect(await runTarget(["list"])).toEqual({
      exitCode: 2,
      stdout: "out",
      stderr: "err",
    });
    expect(seen.map((request) => [...request.args])).toEqual([
      ["--no-install", "/r/cli.ts", "list"],
    ]);
    expect(seen.map((request) => request.timeoutMilliseconds)).toEqual([
      20_000,
    ]);
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
