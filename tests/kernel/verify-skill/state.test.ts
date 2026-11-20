import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { alive } from "../lifecycle/harness.ts";
import {
  environment,
  field,
  front,
  frontDoor,
  helper,
  helperBound,
  helperEntry,
  ledgeredPid,
  ledgerHolds,
  releaseFifo,
  releaseWorlds,
  resultCause,
  targetEntry,
  watchdog,
  world,
} from "./harness.ts";
import type { World } from "./harness.ts";

afterAll(releaseWorlds);

async function holding(at: World) {
  await helper(at, "launch", "r1", "--entry", targetEntry);
  const ledger = join(at.repo, "ledger");
  const gate = join(at.repo, "gate");
  const made = await spawnBounded(["mkfifo", gate], {
    boundMilliseconds: helperBound,
  });
  expect(made.exit).toBe(0);
  return { ledger, gate, argv: JSON.stringify(["hold", ledger, gate]) };
}

describe("the helper's state", () => {
  test(
    "a drive that holds a run makes a cleanup of that run DOMAIN_VERIFY_RUN_HELD, and the drive then finishes",
    async () => {
      const at = world();
      const { ledger, gate, argv } = await holding(at);
      const held = helper(at, "drive", "r1", "held", argv);
      try {
        await ledgerHolds(ledger, "holding", helperBound);
        const cleanup = await helper(at, "cleanup", "r1");
        expect({ exit: cleanup.exit, cause: resultCause(cleanup) }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_RUN_HELD",
        });
      } finally {
        releaseFifo(gate);
      }
      expect(resultCause(await held)).toBe("SUCCESS_COMPLETED");
    },
    watchdog(4),
  );

  test(
    "a helper killed in the middle of a drive leaves the run DOMAIN_VERIFY_RUN_UNRESOLVED, and pending lists the unfinished drive",
    async () => {
      const at = world();
      await helper(at, "launch", "r1", "--entry", targetEntry);
      const killed = await spawnBounded(
        [
          process.execPath,
          helperEntry,
          "drive",
          "r1",
          "orphan",
          '["orphan","now"]',
        ],
        { cwd: at.repo, env: environment(at), boundMilliseconds: helperBound },
      );
      expect(killed.signal).toBe("SIGKILL");
      const cleanup = await helper(at, "cleanup", "r1");
      expect({ exit: cleanup.exit, cause: resultCause(cleanup) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
      });
      const pending = await helper(at, "pending");
      expect(field(pending.result, "data", "unfinished")).toEqual([
        expect.objectContaining({
          commandIdentity: "verify-agent-cli.drive",
          effects: ["step.run", "step.write"],
        }),
      ]);
    },
    watchdog(4),
  );

  test(
    "verify.ts stopped by SIGTERM in the middle of a drive stops the helper and the target, exits 143, and leaves the run usable",
    async () => {
      const at = world();
      const { ledger, gate, argv } = await holding(at);
      let stopped: { readonly exit: number; readonly stderr: string };
      try {
        stopped = await spawnBounded(
          [process.execPath, frontDoor, "drive", "r1", "held", argv],
          {
            cwd: at.repo,
            env: environment(at),
            boundMilliseconds: helperBound,
            signalAt: { ledger, line: "holding", signal: "SIGTERM" },
          },
        );
      } finally {
        if (alive(ledgeredPid(ledger))) releaseFifo(gate);
      }
      expect({ exit: stopped.exit, stderr: stopped.stderr }).toEqual({
        exit: 143,
        stderr:
          "verify-agent-cli: stopped by SIGTERM; the helper stopped its drive first.\n",
      });
      expect(alive(ledgeredPid(ledger))).toBe(false);
      const cleanup = await front(at, "cleanup", "r1");
      expect(cleanup.exit).toBe(0);
    },
    watchdog(4),
  );

  test(
    "a state folder that is a file makes launch DOMAIN_VERIFY_STATE_UNAVAILABLE and pending DOMAIN_VERIFY_STATE_UNAVAILABLE",
    async () => {
      const at = world();
      mkdirSync(join(at.state, "verify-agent-cli"));
      writeFileSync(
        join(at.state, "verify-agent-cli", "state"),
        "not a folder",
      );
      const launch = await helper(at, "launch", "r1", "--entry", targetEntry);
      expect({ exit: launch.exit, cause: resultCause(launch) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      });
      const pending = await helper(at, "pending");
      expect({ exit: pending.exit, cause: resultCause(pending) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      });
    },
    watchdog(2),
  );

  test(
    "pending reports no unfinished change before any change has run",
    async () => {
      const at = world();
      const pending = await helper(at, "pending");
      expect({
        exit: pending.exit,
        cause: resultCause(pending),
        unfinished: field(pending.result, "data", "unfinished"),
      }).toEqual({ exit: 0, cause: "SUCCESS_UNCHANGED", unfinished: [] });
    },
    watchdog(1),
  );

  test(
    "a run record the helper cannot read makes drive fail before it starts the target, as DOMAIN_VERIFY_CHANGE_UNCHANGED",
    async () => {
      const at = world();
      await helper(at, "launch", "r1", "--entry", targetEntry);
      writeFileSync(join(at.runs, "r1/evidence/run.json"), '{"run":"another"}');
      const ran = await helper(at, "drive", "r1", "s", '["status"]');
      expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_CHANGE_UNCHANGED",
      });
      expect(ran.stdout).toContain("is not a run record this helper wrote");
    },
    watchdog(2),
  );

  test(
    "a scratch folder cleanup cannot remove makes cleanup DOMAIN_VERIFY_CHANGE_UNKNOWN",
    async () => {
      const at = world();
      await helper(at, "launch", "r1", "--entry", targetEntry);
      const home = join(at.runs, "r1/scratch/home");
      mkdirSync(join(home, "kept"));
      chmodSync(home, 0o500);
      try {
        const cleanup = await helper(at, "cleanup", "r1");
        expect({ exit: cleanup.exit, cause: resultCause(cleanup) }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_CHANGE_UNKNOWN",
        });
      } finally {
        chmodSync(home, 0o700);
      }
    },
    watchdog(2),
  );
});
