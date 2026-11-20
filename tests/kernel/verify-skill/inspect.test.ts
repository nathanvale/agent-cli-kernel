import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  brokenEntry,
  resultCause,
  environment,
  field,
  frontDoor,
  helper,
  helperBound,
  liarEntry,
  releaseWorlds,
  skill,
  targetEntry,
  world,
} from "./harness.ts";
import type { World } from "./harness.ts";

setDefaultTimeout(90_000);
afterAll(releaseWorlds);

function front(at: World, ...argv: readonly string[]) {
  return spawnBounded([process.execPath, frontDoor, ...argv], {
    cwd: at.repo,
    env: environment(at),
    boundMilliseconds: helperBound,
  });
}

describe("doctor", () => {
  test("doctor reports the target's pin and commands when it answers help and discovery", async () => {
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
    expect(field(ran.result, "data", "commands")).toEqual([
      { identity: "target.hold", route: ["hold"], effectClass: "inspect" },
      { identity: "target.name", route: ["name"], effectClass: "inspect" },
      { identity: "target.status", route: ["status"], effectClass: "inspect" },
    ]);
  });

  test("doctor refuses as DOMAIN_VERIFY_DOCTOR_FAILED, naming each failed check, when the entry is missing or the run was never launched", async () => {
    const at = world();
    const ran = await helper(at, "doctor", "--run", "nope");
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_DOCTOR_FAILED",
    });
    const message = String(field(JSON.parse(ran.stdout), "message"));
    expect(message).toContain("run nope was never launched");
    expect(message).toContain("src/cli.ts does not exist");
  });

  test("doctor refuses a target whose unknown command does not exit 2, as DOMAIN_VERIFY_DOCTOR_FAILED", async () => {
    const at = world();
    const ran = await helper(at, "doctor", "--entry", liarEntry);
    expect(resultCause(ran)).toBe("DOMAIN_VERIFY_DOCTOR_FAILED");
    expect(String(field(JSON.parse(ran.stdout), "message"))).toContain(
      "an unknown command exited 0; it must exit 2",
    );
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
    expect(field(ran.result, "data", "owed")).toEqual([
      { command: "target.hold", cause: "SUCCESS_UNCHANGED" },
      { command: "target.name", cause: "SUCCESS_UNCHANGED" },
      { command: "target.name", cause: "DOMAIN_TARGET_UNKNOWN_NAME" },
    ]);
  });

  test("sweep --run counts the results a run's drive steps reached, so they leave owed", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    await helper(at, "drive", "r1", "known", '["name","known","--json"]');
    await helper(at, "drive", "r1", "pluto", '["name","pluto","--json"]');
    const ran = await helper(
      at,
      "sweep",
      "--entry",
      targetEntry,
      "--run",
      "r1",
    );
    expect(field(ran.result, "data", "owed")).toEqual([
      { command: "target.hold", cause: "SUCCESS_UNCHANGED" },
    ]);
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
      argv: ["verify-agent-cli-no-such-command"],
      expected: "2",
      saw: "0",
    });
  });
});

describe("the front door, verify.ts, which does not go through the kernel", () => {
  test("verify.ts relays the helper's result and exit code when the raw checks hold", async () => {
    const at = world();
    const ran = await front(at, "doctor", "--entry", targetEntry);
    expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(ran.stdout).toStartWith("target is worth driving: 3 commands.\n");
    const refused = await front(at, "evidence", "nope");
    expect({ exit: refused.exit, stderr: refused.stderr }).toEqual({
      exit: 3,
      stderr:
        "verify-agent-cli: No run named nope under " +
        `${at.state}/verify-agent-cli. [DOMAIN_VERIFY_RUN_MISSING]\n`,
    });
    const json = await front(at, "pending", "--json");
    expect(field(JSON.parse(json.stdout), "result", "causeCode")).toBe(
      "SUCCESS_UNCHANGED",
    );
  });

  test("verify.ts doctor exits 70 with RAW FAIL lines when the target's raw exit codes break the kernel's promises", async () => {
    const at = world();
    const ran = await front(at, "doctor", "--entry", liarEntry);
    expect(ran.exit).toBe(70);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toContain(
      "verify-agent-cli: RAW FAIL target-usage: an unknown command exited 0",
    );
  });

  test("verify.ts doctor exits 70 naming both raw target checks when the target throws before its kernel answers", async () => {
    const at = world();
    const ran = await front(at, "doctor", "--entry", brokenEntry);
    expect(ran.exit).toBe(70);
    expect(ran.stderr).toContain("verify-agent-cli: RAW FAIL target-usage: ");
    expect(ran.stderr).toContain(
      "verify-agent-cli: RAW FAIL target-discovery: --discover --json exited 1",
    );
  });

  test("verify.ts exits 70 with RAW FAIL kernel-import when agent-cli-kernel does not load", async () => {
    const at = world();
    const outside = testFolder("kernel-verify-skill-copy-");
    const copy = join(outside, "skill");
    cpSync(skill, copy, { recursive: true });
    const ran = await spawnBounded(
      [process.execPath, "--no-install", join(copy, "verify.ts"), "pending"],
      { cwd: at.repo, env: environment(at), boundMilliseconds: helperBound },
    ).finally(() => rmSync(outside, { recursive: true, force: true }));
    expect(ran.exit).toBe(70);
    expect(ran.stderr).toContain("verify-agent-cli: RAW FAIL kernel-import: ");
    expect(ran.stderr).toContain(
      "verify-agent-cli: RAW FAIL helper-no-envelope: ",
    );
  });
});
