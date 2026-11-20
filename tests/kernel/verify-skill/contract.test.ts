import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  field,
  helper,
  helperBound,
  liarEntry,
  readJson,
  releaseWorlds,
  resultCause,
  targetEntry,
  watchdog,
  world,
} from "./harness.ts";

setDefaultTimeout(watchdog(4));
afterAll(releaseWorlds);

function failed(step: unknown): readonly unknown[] {
  return [
    ...(Array.isArray(field(step, "contract"))
      ? [field(step, "contract")]
      : []),
  ]
    .flat()
    .filter((check) => field(check, "met") === false)
    .map((check) => field(check, "expectation"));
}

describe("what the kernel promises every command, checked on each drive", () => {
  test("an envelope whose exit code is not the process's fails the drive, and sweep --run does not count its result", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", liarEntry);
    const ran = await helper(
      at,
      "drive",
      "r1",
      "claim",
      '["claim","--json"]',
      "--expect-exit",
      "0",
    );
    expect(resultCause(ran)).toBe("DOMAIN_VERIFY_EXPECTATION_UNMET");
    expect(failed(readJson(join(at.runs, "r1/evidence/claim.json")))).toEqual([
      "contract: the envelope's exit code is the process's",
    ]);
    const swept = await helper(at, "findings", "--run", "r1");
    expect(field(swept.result, "data", "owed")).toContainEqual({
      command: "liar.status",
      cause: "SUCCESS_UNCHANGED",
    });
  });

  test("a failed run that prints on stdout fails the drive, even when its exit code and cause are the ones expected", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", liarEntry);
    const ran = await helper(
      at,
      "drive",
      "r1",
      "leak",
      '["leak"]',
      "--expect-exit",
      "2",
      "--expect-cause",
      "USAGE_UNKNOWN_COMMAND",
    );
    expect(resultCause(ran)).toBe("DOMAIN_VERIFY_EXPECTATION_UNMET");
    expect(failed(readJson(join(at.runs, "r1/evidence/leak.json")))).toEqual([
      "contract: a failed run prints nothing on stdout",
    ]);
  });

  test("--json with no envelope fails the drive, and --expect-empty-stdout fails on any stdout", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", liarEntry);
    await helper(at, "drive", "r1", "plain", '["status","--json"]');
    expect(failed(readJson(join(at.runs, "r1/evidence/plain.json")))).toEqual([
      "contract: --json prints one envelope on stdout",
      "contract: --json leaves stderr empty",
    ]);
    const empty = await helper(
      at,
      "drive",
      "r1",
      "help",
      '["--help"]',
      "--expect-empty-stdout",
    );
    expect(resultCause(empty)).toBe("DOMAIN_VERIFY_EXPECTATION_UNMET");
  });
});

describe("the bounds drive keeps", () => {
  test("drive keeps at most 1 MiB of each stream and marks the cut", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    await helper(at, "drive", "r1", "flood", '["flood","now","--json"]');
    const kept = readJson(join(at.runs, "r1/evidence/flood.json"));
    expect(field(kept, "outputTruncated")).toBe(true);
    expect(String(field(kept, "stdout")).length).toBe(1_048_576);
  });

  test("a target that holds out after SIGTERM is killed when its 2 s shutdown budget runs out", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    const gate = join(at.repo, "gate");
    const made = await spawnBounded(["mkfifo", gate], {
      boundMilliseconds: helperBound,
    });
    expect(made.exit).toBe(0);
    await helper(
      at,
      "drive",
      "r1",
      "stubborn",
      JSON.stringify(["hold", join(at.repo, "ledger"), gate]),
      "--timeout-ms",
      "300",
    );
    const kept = readJson(join(at.runs, "r1/evidence/stubborn.json"));
    expect(kept).toMatchObject({ timedOut: true, terminationConfirmed: true });
    expect(Number(field(kept, "elapsedMilliseconds"))).toBeLessThan(5_000);
  });
});

describe("what drive refuses before it starts the target", () => {
  test("a run whose record is gone is DOMAIN_VERIFY_RUN_MISSING even while its scratch folder remains", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    rmSync(join(at.runs, "r1/evidence/run.json"));
    const ran = await helper(at, "drive", "r1", "s", '["status"]');
    expect(resultCause(ran)).toBe("DOMAIN_VERIFY_RUN_MISSING");
  });

  test("a file --read-file cannot read is kept as a problem, not as an empty file", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    mkdirSync(join(at.runs, "r1/scratch/folder"));
    await helper(
      at,
      "drive",
      "r1",
      "read",
      '["status"]',
      "--read-file",
      "folder",
    );
    await helper(
      at,
      "drive",
      "r1",
      "gone",
      '["status"]',
      "--read-file",
      "gone.txt",
    );
    const unreadable = field(
      readJson(join(at.runs, "r1/evidence/read.json")),
      "file",
    );
    expect(field(unreadable, "text")).toBe(null);
    expect(String(field(unreadable, "problem"))).toContain("EISDIR");
    expect(
      field(readJson(join(at.runs, "r1/evidence/gone.json")), "file"),
    ).toMatchObject({ text: null, problem: "absent" });
  });
});
