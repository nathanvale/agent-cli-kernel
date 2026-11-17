import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startChild } from "../scripts/child-env.ts";
import { signalGroupIfPresent } from "./support/signal.ts";
import { testFolder } from "./support/test-folder.ts";

const testTimeout = 30_000;
const reapBound = 10_000;

const folders: string[] = [];
const groups: number[] = [];
afterAll(() => {
  for (const group of groups) signalGroupIfPresent(group, "SIGKILL");
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = testFolder("child-env-");
  folders.push(made);
  return made;
}

function start(...args: Parameters<typeof startChild>) {
  const child = startChild(...args);
  groups.push(child.pid);
  return child;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ESRCH") return false;
    throw error;
  }
}

// Platform: an orphan is reaped by init or launchd, not by this process, so
// it can answer signal 0 for a while after it was killed.
function exited(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const gone = !running(pid);
      if (!gone && Date.now() - started < reapBound) return;
      clearInterval(poll);
      resolve(gone);
    }, 5);
  });
}

function whenLedgerHas(ledger: string, line: string): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!existsSync(ledger)) return;
      if (!readFileSync(ledger, "utf8").split("\n").includes(line)) return;
      clearInterval(poll);
      resolve();
    }, 5);
  });
}

test(
  "CE.a a child that hangs past its limit is stopped with its whole group and reported timed out",
  async () => {
    const pids = join(folder(), "pids");
    const limitMilliseconds = 5_000;
    const started = Date.now();
    const child = start(["sh", "-c", `sleep 300 & echo $! > '${pids}'; wait`], {
      limitMilliseconds,
      graceMilliseconds: 2_000,
    });
    const run = await child.finished;
    expect(Date.now() - started).toBeGreaterThanOrEqual(limitMilliseconds);
    expect(run.timedOut).toBe(true);
    expect(run.signalCode).toBe("SIGTERM");
    const grandchild = Number(readFileSync(pids, "utf8").trim());
    expect(await exited(grandchild)).toBe(true);
  },
  testTimeout,
);

test(
  "CE.b a stop that the child ignores escalates to SIGKILL for the whole group after the grace",
  async () => {
    const root = folder();
    const ledger = join(root, "ledger");
    const pids = join(root, "pids");
    const child = start(
      [
        "sh",
        "-c",
        `trap '' TERM; sleep 300 & echo $! > '${pids}'; echo started >> '${ledger}'; wait`,
      ],
      { graceMilliseconds: 1_000 },
    );
    await whenLedgerHas(ledger, "started");
    child.stop();
    const run = await child.finished;
    expect(run.timedOut).toBe(false);
    expect(run.signalCode).toBe("SIGKILL");
    const grandchild = Number(readFileSync(pids, "utf8").trim());
    expect(await exited(grandchild)).toBe(true);
  },
  testTimeout,
);

test(
  "CE.c a child that finishes inside its limit reports both streams and its exit code",
  async () => {
    const run = await start(["sh", "-c", "echo out; echo err >&2; exit 3"], {
      limitMilliseconds: 20_000,
    }).finished;
    expect(run).toEqual({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 3,
      signalCode: null,
      timedOut: false,
    });
  },
  testTimeout,
);
