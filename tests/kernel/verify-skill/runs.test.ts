import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  resultCause,
  field,
  helper,
  readJson,
  releaseWorlds,
  targetEntry,
  world,
} from "./harness.ts";

setDefaultTimeout(60_000);
afterAll(releaseWorlds);

describe("launch", () => {
  test("launch makes a run's scratch and evidence folders, and a second launch of that name is refused as DOMAIN_VERIFY_RUN_EXISTS", async () => {
    const at = world();
    const first = await helper(at, "launch", "r1", "--entry", targetEntry);
    expect({ exit: first.exit, cause: resultCause(first) }).toEqual({
      exit: 0,
      cause: "SUCCESS_COMPLETED",
    });
    expect(existsSync(join(at.runs, "r1/scratch/home"))).toBe(true);
    expect(readJson(join(at.runs, "r1/evidence/run.json"))).toMatchObject({
      run: "r1",
      repository: at.repo,
      entry: targetEntry,
    });
    const again = await helper(at, "launch", "r1", "--entry", targetEntry);
    expect({ exit: again.exit, cause: resultCause(again) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_RUN_EXISTS",
    });
  });

  test("launch refuses a folder with no installed kernel as DOMAIN_VERIFY_TARGET_MISSING, and makes no run", async () => {
    const at = world();
    rmSync(join(at.repo, "node_modules"), { recursive: true });
    const ran = await helper(at, "launch", "r1", "--entry", targetEntry);
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_TARGET_MISSING",
    });
    expect(ran.stdout).toContain("node_modules/agent-cli-kernel/package.json");
    expect(existsSync(join(at.runs, "r1"))).toBe(false);
  });
});

describe("drive", () => {
  test("drive keeps one evidence file per step with what the target printed, and passes when every expectation holds", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    const ran = await helper(
      at,
      "drive",
      "r1",
      "status",
      '["status","--json"]',
      "--expect-exit",
      "0",
      "--expect-cause",
      "SUCCESS_UNCHANGED",
      "--expect-stdout",
      '"ready":true',
      "--expect-empty-stderr",
    );
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 0,
      cause: "SUCCESS_COMPLETED",
    });
    const kept = readJson(join(at.runs, "r1/evidence/status.json"));
    expect(kept).toMatchObject({
      step: "status",
      argv: ["status", "--json"],
      exitCode: 0,
      stderr: "",
      oneEnvelope: true,
      commandIdentity: "target.status",
      causeCode: "SUCCESS_UNCHANGED",
      timedOut: false,
      terminationConfirmed: true,
    });
    expect(field(kept, "checks")).toEqual([
      { expectation: "--expect-exit", wanted: 0, seen: 0, met: true },
      {
        expectation: "--expect-cause",
        wanted: "SUCCESS_UNCHANGED",
        seen: "SUCCESS_UNCHANGED",
        met: true,
      },
      {
        expectation: "--expect-stdout",
        wanted: '"ready":true',
        seen: true,
        met: true,
      },
      { expectation: "--expect-empty-stderr", wanted: "", seen: "", met: true },
    ]);
  });

  test("drive starts the target in the run's scratch folder, with HOME inside it", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    await helper(at, "drive", "r1", "entry", '["status"]');
    const scratch = join(at.runs, "r1/scratch");
    const command = field(
      readJson(join(at.runs, "r1/evidence/entry.json")),
      "command",
    );
    expect(command).toEqual(
      expect.arrayContaining([
        `HOME=${join(scratch, "home")}`,
        "--cwd",
        scratch,
        targetEntry,
        "status",
      ]),
    );
    await helper(
      at,
      "drive",
      "r1",
      "bun",
      '["-e","process.stdout.write(process.cwd() + \\" \\" + process.env.HOME)"]',
      "--bun",
    );
    expect(
      field(readJson(join(at.runs, "r1/evidence/bun.json")), "stdout"),
    ).toBe(`${at.repo} ${join(scratch, "home")}`);
  });

  test("drive reports an unmet expectation as DOMAIN_VERIFY_EXPECTATION_UNMET and still keeps the evidence", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    const ran = await helper(
      at,
      "drive",
      "r1",
      "unknown",
      '["name","pluto"]',
      "--expect-exit",
      "0",
    );
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_EXPECTATION_UNMET",
    });
    expect(readJson(join(at.runs, "r1/evidence/unknown.json"))).toMatchObject({
      exitCode: 3,
      causeCode: "DOMAIN_TARGET_UNKNOWN_NAME",
      checks: [
        { expectation: "--expect-exit", wanted: 0, seen: 3, met: false },
      ],
    });
  });

  test("drive refuses a reused step name as DOMAIN_VERIFY_STEP_EXISTS, and leaves the first evidence as it was", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    await helper(at, "drive", "r1", "s", '["status"]');
    const file = join(at.runs, "r1/evidence/s.json");
    const before = readFileSync(file, "utf8");
    const again = await helper(at, "drive", "r1", "s", '["name","known"]');
    expect({ exit: again.exit, cause: resultCause(again) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_STEP_EXISTS",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("drive refuses argv that is not a JSON array of strings as DOMAIN_VERIFY_ARGV_INVALID", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    for (const argv of ["status", '["status",1]', '{"a":"b"}']) {
      const ran = await helper(at, "drive", "r1", "s", argv);
      expect({ argv, exit: ran.exit, cause: resultCause(ran) }).toEqual({
        argv,
        exit: 3,
        cause: "DOMAIN_VERIFY_ARGV_INVALID",
      });
    }
    expect(existsSync(join(at.runs, "r1/evidence/s.json"))).toBe(false);
  });

  test("drive stops a target that outlives --timeout-ms, and keeps the evidence of the stop", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    const ran = await helper(
      at,
      "drive",
      "r1",
      "stopped",
      '["-e","await new Promise(() => setInterval(() => {}, 1000))"]',
      "--bun",
      "--timeout-ms",
      "500",
    );
    expect(resultCause(ran)).toBe("SUCCESS_COMPLETED");
    expect(readJson(join(at.runs, "r1/evidence/stopped.json"))).toMatchObject({
      timedOut: true,
      terminationConfirmed: true,
    });
  });
});

describe("cleanup and evidence", () => {
  test("cleanup removes the scratch folder and keeps the evidence; a second cleanup is refused as DOMAIN_VERIFY_RUN_CLEAN and a later drive is DOMAIN_VERIFY_RUN_MISSING", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    await helper(at, "drive", "r1", "s", '["status"]', "--expect-exit", "0");
    const first = await helper(at, "cleanup", "r1");
    expect({ exit: first.exit, cause: resultCause(first) }).toEqual({
      exit: 0,
      cause: "SUCCESS_COMPLETED",
    });
    expect(existsSync(join(at.runs, "r1/scratch"))).toBe(false);
    const second = await helper(at, "cleanup", "r1");
    expect({ exit: second.exit, cause: resultCause(second) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_RUN_CLEAN",
    });
    const listed = await helper(at, "evidence", "r1");
    expect(field(listed.result, "data")).toMatchObject({
      scratch: "removed",
      steps: [{ step: "s", exitCode: 0, unmet: 0 }],
    });
    const late = await helper(at, "drive", "r1", "late", '["status"]');
    expect(resultCause(late)).toBe("DOMAIN_VERIFY_RUN_MISSING");
  });

  test("drive, cleanup and evidence refuse a run that was never launched as DOMAIN_VERIFY_RUN_MISSING", async () => {
    const at = world();
    for (const argv of [
      ["drive", "nope", "s", '["status"]'],
      ["cleanup", "nope"],
      ["evidence", "nope"],
    ]) {
      const ran = await helper(at, ...argv);
      expect({ argv, exit: ran.exit, cause: resultCause(ran) }).toEqual({
        argv,
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_MISSING",
      });
    }
  });
});
