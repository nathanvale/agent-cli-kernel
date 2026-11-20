import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  brokenEntry,
  field,
  helper,
  liarEntry,
  releaseWorlds,
  resultCause,
  targetEntry,
  watchdog,
  world,
} from "./harness.ts";

setDefaultTimeout(watchdog(4));
afterAll(releaseWorlds);

function message(ran: { readonly stdout: string }): string {
  return String(field(JSON.parse(ran.stdout), "message"));
}

describe("doctor", () => {
  test("doctor reports the target's pin and commands when it answers help, an unknown command and discovery", async () => {
    const at = world();
    const ran = await helper(at, "doctor", "--entry", targetEntry);
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 0,
      cause: "SUCCESS_UNCHANGED",
    });
    expect(field(ran.result, "data")).toMatchObject({
      pin: "test",
      cli: "target",
    });
    expect(field(ran.result, "data", "commands")).toContainEqual({
      identity: "target.status",
      route: ["status"],
      effectClass: "inspect",
    });
  });

  test("doctor uses the entry a run recorded when it is given only the run", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    const ran = await helper(at, "doctor", "--run", "r1");
    expect(field(ran.result, "data", "entry")).toBe(targetEntry);
  });

  test("doctor refuses as DOMAIN_VERIFY_DOCTOR_FAILED, naming each failed check, when the entry is missing or the run was never launched", async () => {
    const at = world();
    const ran = await helper(at, "doctor", "--run", "nope");
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_DOCTOR_FAILED",
    });
    expect(message(ran)).toContain("run nope was never launched");
    expect(message(ran)).toContain("src/cli.ts does not exist");
  });

  test("doctor refuses a target whose unknown command does not exit 2, as DOMAIN_VERIFY_DOCTOR_FAILED", async () => {
    const at = world();
    const ran = await helper(at, "doctor", "--entry", liarEntry);
    expect(resultCause(ran)).toBe("DOMAIN_VERIFY_DOCTOR_FAILED");
    expect(message(ran)).toBe(
      "Doctor failed: an unknown command exited 0; it must exit 2.",
    );
  });

  test("doctor refuses a target whose help fails, as DOMAIN_VERIFY_DOCTOR_FAILED", async () => {
    const at = world();
    const ran = await helper(at, "doctor", "--entry", brokenEntry);
    expect(resultCause(ran)).toBe("DOMAIN_VERIFY_DOCTOR_FAILED");
    expect(message(ran)).toContain("--help exited 1 with 0 bytes of stdout");
  });

  test("doctor reports a package.json it cannot read as unreadable, not as missing", async () => {
    const at = world();
    writeFileSync(join(at.repo, "package.json"), "{ not json");
    const ran = await helper(at, "doctor", "--entry", targetEntry);
    expect(resultCause(ran)).toBe("DOMAIN_VERIFY_DOCTOR_FAILED");
    expect(message(ran)).toContain("package.json is not JSON");
  });
});

describe("sweep and findings", () => {
  test("sweep passes a sound target and lists the declared results no step has reached as owed", async () => {
    const at = world();
    const ran = await helper(at, "sweep", "--entry", targetEntry);
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 0,
      cause: "SUCCESS_UNCHANGED",
    });
    const owed = field(ran.result, "data", "owed");
    expect(owed).toContainEqual({
      command: "target.name",
      cause: "SUCCESS_UNCHANGED",
    });
    expect(owed).toContainEqual({
      command: "target.name",
      cause: "DOMAIN_TARGET_UNKNOWN_NAME",
    });
  });

  test("sweep --run uses the run's entry and counts the results its drive steps reached, so they leave owed", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    await helper(at, "drive", "r1", "known", '["name","known","--json"]');
    await helper(at, "drive", "r1", "pluto", '["name","pluto","--json"]');
    const ran = await helper(at, "sweep", "--run", "r1");
    expect(resultCause(ran)).toBe("SUCCESS_UNCHANGED");
    expect(
      JSON.stringify(field(ran.result, "data", "owed")).includes("target.name"),
    ).toBe(false);
  });

  test("sweep refuses a target that breaks the kernel's promises as DOMAIN_VERIFY_SWEEP_FAILED, and findings lists every failed check", async () => {
    const at = world();
    const ran = await helper(at, "sweep", "--entry", liarEntry);
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_SWEEP_FAILED",
    });
    const listed = await helper(at, "findings", "--entry", liarEntry);
    expect({ exit: listed.exit, cause: resultCause(listed) }).toEqual({
      exit: 0,
      cause: "SUCCESS_UNCHANGED",
    });
    expect(field(listed.result, "data", "findings")).toContainEqual({
      check: "unknown-command-exit",
      argv: ["verify-cli-no-such-command"],
      expected: "2",
      saw: "0",
    });
  });

  test("evidence and sweep --run refuse a run whose evidence holds a file they cannot read, as DOMAIN_VERIFY_EVIDENCE_UNREADABLE", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    writeFileSync(join(at.runs, "r1/evidence/bad.json"), "{ not json");
    for (const argv of [
      ["evidence", "r1"],
      ["sweep", "--run", "r1"],
      ["findings", "--run", "r1"],
    ]) {
      const ran = await helper(at, ...argv);
      expect({ argv, cause: resultCause(ran) }).toEqual({
        argv,
        cause: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
      });
      expect(message(ran)).toContain("bad.json is not JSON");
    }
  });
});
