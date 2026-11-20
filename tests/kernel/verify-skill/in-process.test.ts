import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { helperContract } from "../../../skills/verify-agent-cli/helper/cli.ts";
import type { Refusal } from "agent-cli-kernel/addons/state";
import { refusalOf } from "../../../skills/verify-agent-cli/helper/outcome.ts";
import {
  readRunRecord,
  runPlace,
  verificationFolder,
} from "../../../skills/verify-agent-cli/helper/place.ts";
import {
  causeOf,
  checks,
  envelopeOf,
  identityOf,
} from "../../../skills/verify-agent-cli/helper/transcript.ts";
import {
  entryOf,
  helperFailures,
  kernelFailures,
  relayed,
  targetFailures,
  verify,
} from "../../../skills/verify-agent-cli/verify.ts";
import {
  environment,
  field,
  liarEntry,
  releaseWorlds,
  repository,
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
    expect(await causeAfter(["evidence", "r1"])).toBe("SUCCESS_UNCHANGED");
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
      checks(
        {
          exitCode: undefined,
          causeCode: undefined,
          stdout: [],
          stderr: [],
          emptyStderr: false,
          file: undefined,
        },
        seen,
      ),
    ).toEqual([]);
    expect(
      checks(
        {
          exitCode: 0,
          causeCode: "USAGE_X",
          stdout: ["out", "absent"],
          stderr: ["missing"],
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
      "/s/verify-agent-cli",
    );
    expect(verificationFolder({ XDG_STATE_HOME: "s", HOME: "/h" })).toBe(
      "/h/.local/state/verify-agent-cli",
    );
    expect(() => verificationFolder({ HOME: "h" })).toThrow(
      new Error(
        "verify-agent-cli needs XDG_STATE_HOME or HOME as an absolute path, to place its runs. Repair: set HOME, or XDG_STATE_HOME, to an absolute folder.",
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

describe("the check that does not go through the kernel", () => {
  test("the kernel loads, so it adds no failure", async () => {
    expect(await kernelFailures()).toEqual([]);
  });

  test("the target's raw exit codes pass for a sound CLI and fail for one that lies", () => {
    const place = { cwd: repository, env: process.env };
    expect(targetFailures(targetEntry, place)).toEqual([]);
    expect(
      targetFailures(liarEntry, place).map((line) => line.split(":")[0]),
    ).toEqual(["target-usage"]);
  });

  test("a helper whose envelope disagrees with its exit code, or prints none, is a raw failure", () => {
    const envelope = (exitCode: number) =>
      `${JSON.stringify({ message: "m", result: { exitCode } })}\n`;
    expect(
      helperFailures({ exitCode: 3, stdout: envelope(3), stderr: "" }),
    ).toEqual([]);
    expect(
      helperFailures({ exitCode: 0, stdout: envelope(3), stderr: "" }),
    ).toEqual([
      "helper-exit-mismatch: the helper's envelope says exit 3, but its process exited 0. Its message: m",
    ]);
    expect(
      helperFailures({ exitCode: 1, stdout: "", stderr: "error: boom\n" }),
    ).toEqual([
      "helper-no-envelope: the helper exited 1 without one envelope on stdout. stderr: error: boom",
    ]);
  });

  test("the raw check reads the entry from --entry, else src/cli.ts", () => {
    expect(entryOf(["doctor"], "/r")).toBe("/r/src/cli.ts");
    expect(entryOf(["doctor", "--entry", "bin/x.ts"], "/r")).toBe(
      "/r/bin/x.ts",
    );
    expect(entryOf(["doctor", "--entry", "/abs/x.ts"], "/r")).toBe("/abs/x.ts");
  });

  test("verify runs the raw checks and the helper, and finds nothing wrong with a sound target", async () => {
    const at = world();
    const ran = await verify(["doctor", "--entry", targetEntry], {
      cwd: at.repo,
      env: environment(at),
    });
    expect(ran.failures).toEqual([]);
    expect(ran.helper.exitCode).toBe(0);
  });

  test("the helper's result is relayed as its envelope, its message and data, or one stderr line with its cause", () => {
    const line = (exitCode: number, data: unknown) =>
      `${JSON.stringify({ message: "m", result: { exitCode, causeCode: "C_D", data } })}\n`;
    const ran = (exitCode: number, data: unknown) => ({
      exitCode,
      stdout: line(exitCode, data),
      stderr: "",
    });
    expect(relayed(ran(0, { a: 1 }), true)).toEqual({
      stream: "stdout",
      text: line(0, { a: 1 }),
    });
    expect(relayed(ran(0, { a: 1 }), false)).toEqual({
      stream: "stdout",
      text: 'm\n{\n  "a": 1\n}\n',
    });
    expect(relayed(ran(0, null), false)).toEqual({
      stream: "stdout",
      text: "m\n",
    });
    expect(relayed(ran(3, null), false)).toEqual({
      stream: "stderr",
      text: "verify-agent-cli: m [C_D]\n",
    });
  });
});
