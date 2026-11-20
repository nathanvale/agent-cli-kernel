import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  brokenEntry,
  environment,
  field,
  front,
  helper,
  helperBound,
  liarEntry,
  ownedFolder,
  releaseWorlds,
  skill,
  targetEntry,
  watchdog,
  world,
} from "./harness.ts";

setDefaultTimeout(watchdog(4));
afterAll(releaseWorlds);

describe("the front door, verify.ts, which does not go through the kernel", () => {
  test("verify.ts relays the helper's message and data, its refusals as one stderr line, and its envelope with --json", async () => {
    const at = world();
    const json = await helper(at, "doctor", "--entry", targetEntry);
    const ran = await front(at, "doctor", "--entry", targetEntry);
    expect({ exit: ran.exit, stderr: ran.stderr, stdout: ran.stdout }).toEqual({
      exit: 0,
      stderr: "",
      stdout: `${String(field(JSON.parse(json.stdout), "message"))}\n${JSON.stringify(field(json.result, "data"), null, 2)}\n`,
    });
    const refused = await front(at, "evidence", "nope");
    expect({ exit: refused.exit, stderr: refused.stderr }).toEqual({
      exit: 3,
      stderr: `verify-agent-cli: No run named nope under ${at.state}/verify-agent-cli. [DOMAIN_VERIFY_RUN_MISSING]\n`,
    });
    const envelope = await front(at, "pending", "--json");
    expect(field(JSON.parse(envelope.stdout), "result", "causeCode")).toBe(
      "SUCCESS_UNCHANGED",
    );
  });

  test("verify.ts doctor --run checks the entry the run recorded, not src/cli.ts", async () => {
    const at = world();
    expect((await front(at, "launch", "r1", "--entry", targetEntry)).exit).toBe(
      0,
    );
    const ran = await front(at, "doctor", "--run", "r1");
    expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
  });

  test("verify.ts doctor exits 70 with RAW FAIL target-usage-exit when the target's unknown command exits 0", async () => {
    const at = world();
    const ran = await front(at, "doctor", "--entry", liarEntry);
    expect({ exit: ran.exit, stdout: ran.stdout }).toEqual({
      exit: 70,
      stdout: "",
    });
    expect(ran.stderr.split("\n")[0]).toBe(
      "verify-agent-cli: RAW FAIL target-usage-exit: an unknown command exited 0, not 2. stderr: liar: No declared command matches this invocation. [USAGE_UNKNOWN_COMMAND]",
    );
  });

  test("verify.ts doctor exits 70 naming both raw target checks when the target throws before its kernel answers", async () => {
    const at = world();
    const ran = await front(at, "doctor", "--entry", brokenEntry);
    expect(ran.exit).toBe(70);
    expect(ran.stderr).toContain(
      "verify-agent-cli: RAW FAIL target-usage-exit: an unknown command exited 1",
    );
    expect(ran.stderr).toContain(
      "verify-agent-cli: RAW FAIL target-discovery: --discover --json exited 1",
    );
  });

  test("verify.ts exits 70 with RAW FAIL kernel-import when agent-cli-kernel does not load", async () => {
    const at = world();
    const copy = join(ownedFolder("kernel-verify-skill-copy-"), "skill");
    cpSync(skill, copy, { recursive: true });
    expect(() => Bun.resolveSync("agent-cli-kernel", copy)).toThrow(
      "Cannot find package 'agent-cli-kernel'",
    );
    const ran = await spawnBounded(
      [process.execPath, "--no-install", join(copy, "verify.ts"), "pending"],
      { cwd: at.repo, env: environment(at), boundMilliseconds: helperBound },
    );
    expect(ran.exit).toBe(70);
    expect(ran.stderr).toContain("verify-agent-cli: RAW FAIL kernel-import: ");
    expect(ran.stderr).toContain(
      "verify-agent-cli: RAW FAIL helper-no-envelope: ",
    );
  });
});
