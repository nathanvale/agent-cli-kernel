import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startChild } from "../../../scripts/process-runner.ts";
import { spawnBounded, watchLedger } from "../../support/process.ts";
import {
  resultCause,
  environment,
  field,
  helper,
  helperBound,
  helperEntry,
  releaseWorlds,
  targetEntry,
  world,
} from "./harness.ts";
import type { World } from "./harness.ts";

setDefaultTimeout(60_000);
afterAll(releaseWorlds);

const holdBound = 20_000;

async function fifo(path: string): Promise<void> {
  const made = await spawnBounded(["mkfifo", path]);
  expect(made.exit).toBe(0);
}

async function holding(at: World) {
  await helper(at, "launch", "r1", "--entry", targetEntry);
  const ledger = join(at.repo, "ledger");
  const gate = join(at.repo, "gate");
  await fifo(gate);
  return { ledger, gate, argv: JSON.stringify(["hold", ledger, gate]) };
}

describe("the helper's state", () => {
  test("a drive that holds a run makes a cleanup of that run DOMAIN_VERIFY_RUN_HELD, and the drive then finishes", async () => {
    const at = world();
    const { ledger, gate, argv } = await holding(at);
    const watch = watchLedger(ledger, "holding", holdBound);
    const held = helper(at, "drive", "r1", "held", argv);
    await watch.reached;
    const cleanup = await helper(at, "cleanup", "r1");
    expect({ exit: cleanup.exit, cause: resultCause(cleanup) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_RUN_HELD",
    });
    writeFileSync(gate, "go");
    const finished = await held;
    expect(resultCause(finished)).toBe("SUCCESS_COMPLETED");
  });

  test("a helper killed in the middle of a drive leaves the run DOMAIN_VERIFY_RUN_UNRESOLVED, and pending lists the unfinished drive", async () => {
    const at = world();
    const { ledger, gate, argv } = await holding(at);
    const watch = watchLedger(ledger, "holding", holdBound);
    const child = startChild(
      [process.execPath, helperEntry, "drive", "r1", "held", argv, "--json"],
      {
        cwd: at.repo,
        env: environment(at),
        ownGroup: false,
        graceMilliseconds: 0,
      },
    );
    await watch.reached;
    child.stop();
    await child.finished;
    writeFileSync(gate, "go");
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
  });

  test("a helper stopped by SIGTERM in the middle of a drive stops the target and leaves the run usable", async () => {
    const at = world();
    const { ledger, argv } = await holding(at);
    const stopped = await spawnBounded(
      [process.execPath, helperEntry, "drive", "r1", "held", argv, "--json"],
      {
        cwd: at.repo,
        env: environment(at),
        boundMilliseconds: helperBound,
        signalAt: { ledger, line: "holding", signal: "SIGTERM" },
      },
    );
    expect(stopped.exit).toBe(143);
    const cleanup = await helper(at, "cleanup", "r1");
    expect(resultCause(cleanup)).toBe("SUCCESS_COMPLETED");
  });

  test("a state folder that is a file makes launch DOMAIN_VERIFY_STATE_UNAVAILABLE and pending DOMAIN_VERIFY_STATE_UNAVAILABLE", async () => {
    const at = world();
    mkdirSync(join(at.state, "verify-agent-cli"));
    writeFileSync(join(at.state, "verify-agent-cli", "state"), "not a folder");
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
  });

  test("pending reports no unfinished change before any change has run", async () => {
    const at = world();
    const pending = await helper(at, "pending");
    expect({
      exit: pending.exit,
      cause: resultCause(pending),
      unfinished: field(pending.result, "data", "unfinished"),
    }).toEqual({ exit: 0, cause: "SUCCESS_UNCHANGED", unfinished: [] });
  });

  test("a run record the helper cannot read makes drive fail before it starts the target, as DOMAIN_VERIFY_CHANGE_UNCHANGED", async () => {
    const at = world();
    await helper(at, "launch", "r1", "--entry", targetEntry);
    const record = join(at.runs, "r1/evidence/run.json");
    writeFileSync(record, '{"run":"another"}');
    const ran = await helper(at, "drive", "r1", "s", '["status"]');
    expect({ exit: ran.exit, cause: resultCause(ran) }).toEqual({
      exit: 3,
      cause: "DOMAIN_VERIFY_CHANGE_UNCHANGED",
    });
    expect(ran.stdout).toContain("is not a run record this helper wrote");
  });

  test("a scratch folder cleanup cannot remove makes cleanup DOMAIN_VERIFY_CHANGE_UNKNOWN", async () => {
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
  });
});
