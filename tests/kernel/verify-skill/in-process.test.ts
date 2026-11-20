import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helperContract } from "../../../skills/verify-cli/helper/cli.ts";
import type { Refusal } from "agent-cli-kernel/addons/state";
import { readJsonFile } from "../../../skills/verify-cli/helper/json.ts";
import {
  refusalOf,
  unfinishedChange,
} from "../../../skills/verify-cli/helper/outcome.ts";
import { readSteps } from "../../../skills/verify-cli/helper/steps.ts";
import {
  readRunRecord,
  runPlace,
  verificationFolder,
} from "../../../skills/verify-cli/helper/place.ts";
import {
  causeOf,
  expectationChecks,
  contractChecks,
  envelopeOf,
  identityOf,
} from "../../../skills/verify-cli/helper/transcript.ts";
import {
  environment,
  field,
  liarEntry,
  releaseWorlds,
  targetEntry,
  world,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterAll(releaseWorlds);

describe("the helper's commands, run in process", () => {
  test("launch, drive, evidence, sweep, doctor, pending and cleanup each return their success in process", async () => {
    const at = world();
    const run = helperContract(environment(at), at.repo).inProcess;
    const causeAfter = async (argv: readonly string[]) => {
      const ran = await run(argv);
      if (ran.kind !== "envelope")
        throw new Error(`Expected an envelope, got ${ran.kind}.`);
      return ran.envelope.result.causeCode;
    };
    expect(await causeAfter(["launch", "r1", "--entry", targetEntry])).toBe(
      "SUCCESS_COMPLETED",
    );
    expect(
      await causeAfter([
        "drive",
        "r1",
        "s",
        '["status"]',
        "--expect-exit",
        "0",
      ]),
    ).toBe("SUCCESS_COMPLETED");
    expect(
      await causeAfter([
        "drive",
        "r1",
        "read",
        '["touch","made.txt"]',
        "--read-file",
        "made.txt",
        "--expect-file",
        "touched",
      ]),
    ).toBe("SUCCESS_COMPLETED");
    expect(await causeAfter(["evidence", "r1"])).toBe("SUCCESS_UNCHANGED");
    expect(await causeAfter(["sweep", "--run", "r1"])).toBe(
      "SUCCESS_UNCHANGED",
    );
    expect(await causeAfter(["sweep", "--entry", targetEntry])).toBe(
      "SUCCESS_UNCHANGED",
    );
    expect(await causeAfter(["findings", "--entry", liarEntry])).toBe(
      "SUCCESS_UNCHANGED",
    );
    expect(await causeAfter(["doctor", "--run", "r1"])).toBe(
      "SUCCESS_UNCHANGED",
    );
    expect(await causeAfter(["pending"])).toBe("SUCCESS_UNCHANGED");
    expect(await causeAfter(["cleanup", "r1"])).toBe("SUCCESS_COMPLETED");
  });
});

describe("what drive reads from the target's output", () => {
  test("an envelope is one JSON line holding contractVersion and result, and its cause and command come from it", () => {
    const line =
      '{"contractVersion":"3.0.0","result":{"causeCode":"X_Y","commandIdentity":"t.s"}}\n';
    expect(field(envelopeOf(line), "contractVersion")).toBe("3.0.0");
    expect(envelopeOf(`${line}${line}`)).toBe(null);
    expect(envelopeOf('{"result":{}}\n')).toBe(null);
    expect(envelopeOf("not json\n")).toBe(null);
    expect(causeOf(envelopeOf(line), "")).toBe("X_Y");
    expect(identityOf(envelopeOf(line))).toBe("t.s");
    expect(causeOf(null, "t: No such thing. [DOMAIN_T_MISSING]\n")).toBe(
      "DOMAIN_T_MISSING",
    );
    expect(causeOf(null, "t: no cause here\n")).toBe(null);
    expect(identityOf(null)).toBe(null);
  });

  test("each expectation is checked only when given, and records what was seen", () => {
    const seen = {
      exitCode: 2,
      stdout: "out",
      stderr: "t: bad. [USAGE_X]\n",
      file: "one",
    };
    expect(
      expectationChecks(
        {
          exitCode: undefined,
          causeCode: undefined,
          stdout: [],
          stderr: [],
          emptyStdout: false,
          emptyStderr: false,
          file: undefined,
        },
        seen,
      ),
    ).toEqual([]);
    expect(
      expectationChecks(
        {
          exitCode: 0,
          causeCode: "USAGE_X",
          stdout: ["out", "absent"],
          stderr: ["missing"],
          emptyStdout: true,
          emptyStderr: true,
          file: "two",
        },
        seen,
      ).map((check) => [check.expectation, check.met]),
    ).toEqual([
      ["--expect-exit", false],
      ["--expect-cause", true],
      ["--expect-stdout", true],
      ["--expect-stdout", false],
      ["--expect-stderr", false],
      ["--expect-file", false],
      ["--expect-empty-stdout", false],
      ["--expect-empty-stderr", false],
    ]);
  });

  test("each state refusal maps to its station, and a run that ran maps to none", () => {
    expect(refusalOf({ kind: "ran" }, "r")).toBe(undefined);
    expect(
      (
        [
          { kind: "held-lock", operationId: "o" },
          { kind: "unresolved-case", operationId: "o" },
          { kind: "unavailable", reason: "why", detail: "more" },
          { kind: "busy" },
          { kind: "denied" },
        ] satisfies Refusal[]
      ).map((outcome) => refusalOf(outcome, "r")?.causeCode),
    ).toEqual([
      "DOMAIN_VERIFY_RUN_HELD",
      "DOMAIN_VERIFY_RUN_UNRESOLVED",
      "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      "DOMAIN_VERIFY_STATE_UNAVAILABLE",
    ]);
  });
});

describe("where the helper keeps runs", () => {
  test("runs live under XDG_STATE_HOME, else under HOME, and neither absolute is refused", () => {
    expect(verificationFolder({ XDG_STATE_HOME: "/s", HOME: "/h" })).toBe(
      "/s/verify-cli",
    );
    expect(verificationFolder({ XDG_STATE_HOME: "s", HOME: "/h" })).toBe(
      "/h/.local/state/verify-cli",
    );
    expect(() => verificationFolder({ HOME: "h" })).toThrow(
      new Error(
        "verify-cli needs XDG_STATE_HOME or HOME as an absolute path, to place its runs. Repair: set HOME, or XDG_STATE_HOME, to an absolute folder.",
      ),
    );
  });

  test("a run record another run wrote is refused, and a missing one reads as no run", () => {
    const at = world();
    const place = runPlace(at.state, "r1");
    expect(readRunRecord(place)).toBe(undefined);
    const other = runPlace(at.state, "r2");
    writeFileSync(
      join(at.state, "run.json"),
      JSON.stringify({
        run: "r1",
        repository: at.repo,
        entry: targetEntry,
        launchedAt: "2026-11-20T00:00:00.000Z",
      }),
    );
    expect(() =>
      readRunRecord({ ...other, record: join(at.state, "run.json") }),
    ).toThrow(
      new Error(
        `${join(at.state, "run.json")} is not a run record this helper wrote. Repair: launch a new run under another name.`,
      ),
    );
  });
});

describe("the helper's own reads and refusals", () => {
  test("the helper refuses to start without env on PATH, naming the repair", () => {
    const at = world();
    expect(() =>
      helperContract({ ...environment(at), PATH: "" }, at.repo),
    ).toThrow(
      new Error(
        "verify-cli needs env on PATH to start the target. Repair: put the folder that holds env on PATH.",
      ),
    );
  });

  test("a JSON file reads as missing, read, or unreadable with its reason", () => {
    const at = world();
    const file = join(at.repo, "x.json");
    expect(readJsonFile(file)).toEqual({ kind: "missing" });
    writeFileSync(file, '{"a":1}');
    expect(readJsonFile(file)).toEqual({ kind: "read", value: { a: 1 } });
    writeFileSync(file, "{");
    expect(readJsonFile(file).kind).toBe("unreadable");
    expect(readJsonFile(at.repo).kind).toBe("unreadable");
  });

  test("a step file that is not JSON, or not a step, is listed as unreadable rather than as a clean step", () => {
    const at = world();
    const folder = join(at.repo, "evidence");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.json"), "{");
    writeFileSync(join(folder, "b.json"), "{}");
    writeFileSync(
      join(folder, "c.json"),
      JSON.stringify({
        startedAt: "t",
        exitCode: 0,
        checks: [{ met: true }],
        contract: [{ met: false }],
      }),
    );
    const read = readSteps(folder);
    expect(read.unreadable.length).toBe(2);
    expect(read.steps).toMatchObject([
      { step: "c", unmet: 1, contractHeld: false },
    ]);
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

  test("the kernel's promises are checked only for the target's own runs that ended by themselves", () => {
    const seen = { exitCode: 3, stdout: "x\n", stderr: "", file: null };
    const ran = { script: false, timedOut: false };
    expect(contractChecks(seen, ["a"], ran).map((check) => check.met)).toEqual([
      false,
    ]);
    expect(contractChecks(seen, ["a"], { ...ran, script: true })).toEqual([]);
    expect(contractChecks(seen, ["a"], { ...ran, timedOut: true })).toEqual([]);
    expect(
      contractChecks(seen, ["--", "--json"], ran).map(
        (check) => check.expectation,
      ),
    ).toEqual(["contract: a failed run prints nothing on stdout"]);
  });
});
