import { describe, expect, test } from "bun:test";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { type Job, jobOf } from "../../support/workflows.ts";

const job = (name: string): Job => jobOf("ci.yml", name);

describe("the fault-replay gate in Hosted check", () => {
  test("fault-replay fails unless test and every fault-replay-shard job passed", () => {
    const replay = job("fault-replay");

    expect(replay.needs).toEqual(["test", "fault-replay-shard"]);
    expect(replay.steps[0]?.env).toEqual({
      TEST: "${{ needs.test.result }}",
      SHARDS: "${{ needs.fault-replay-shard.result }}",
    });
  });

  test("fault-replay runs even when test or a shard failed, was cancelled or was skipped, so it can fail", () => {
    expect(job("fault-replay").if).toMatch(/^always\(\) && /);
  });

  test("fault-replay-shard sets timeout-minutes to at least 15", () => {
    expect(job("fault-replay-shard")["timeout-minutes"]).toBeGreaterThanOrEqual(
      15,
    );
  });

  test("fault-replay-shard refreshes fault timings into a separate folder and uploads only that folder", () => {
    const shard = job("fault-replay-shard");
    const replayStep = shard.steps.find((step) =>
      step.run?.includes("fault-replay"),
    );
    expect(replayStep?.run).toContain(
      '--update-timings="$RUNNER_TEMP/fault-timings"',
    );
    const uploadStep = shard.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploadStep?.if).toBe("always()");
    expect(uploadStep?.with).toEqual({
      name: "fault-timings-${{ matrix.shard }}",
      path: "${{ runner.temp }}/fault-timings/",
    });
  });

  test(
    "the fault-replay gate passes only when test and the shards both succeeded, and ends with a Repair line when either did not",
    async () => {
      const script = job("fault-replay").steps[0]?.run ?? "";
      const control = await spawnBounded(["bash", "-e", "-c", script], {
        env: { PATH: process.env.PATH, TEST: "success", SHARDS: "success" },
      });
      expect(control.exit).toBe(0);
      expect(control.stderr).toBe("");

      for (const [testResult, shards] of [
        ["failure", "success"],
        ["cancelled", "success"],
        ["skipped", "success"],
        ["success", "failure"],
        ["success", "cancelled"],
        ["success", "skipped"],
        ["", "success"],
      ]) {
        const result = await spawnBounded(["bash", "-e", "-c", script], {
          env: { PATH: process.env.PATH, TEST: testResult, SHARDS: shards },
        });
        expect(result.exit).toBe(1);
        expect(result.stderr.trim()).toMatch(/Repair: .+\.$/);
      }
    },
    processWatchdog(8),
  );
});
