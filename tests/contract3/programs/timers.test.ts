// Finding 1, programs add-on side: the program timeout and the output-drain
// timer honour every admitted value (Nathan, 16 November 2026: no cap).
// Expectations: c3-expect-t2t5, findings-round/expectations.md, T05 and T06.
// Time control (P4, proposed for review) as in lifecycle/timers.test.ts: Bun's
// fake timers move performance.now(); the children are real processes.
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  programDetails,
  programsAddon,
} from "../../../starters/contract3/src/addons/programs/index.ts";
import type { ProgramResult } from "../../../starters/contract3/src/kernel/index.ts";
import { alive } from "../lifecycle/harness.ts";
import {
  advance,
  realPause,
  shell,
  turns,
  until,
} from "../lifecycle/recording-host.ts";

const timeout = 30_000;
const timerLimit = 2_147_483_647;
// The add-on polls a stopping group every 10 ms.
const pollLatency = 10;

afterEach(() => {
  jest.useRealTimers();
});

function control() {
  return {
    runId: "t05-run",
    commandIdentity: "rc.t05",
    summary: "Component test of the programs add-on.",
    signal: new AbortController().signal,
  };
}

type Started = {
  readonly ledger: string;
  readonly lines: () => readonly string[];
  readonly pid: (prefix: string) => number | undefined;
  readonly outcome: () => ProgramResult | undefined;
  readonly cleanup: () => Promise<void>;
};

// Starts one program under fake timers and records its result when it comes.
async function startUnderFakeTime(
  script: (ledger: string) => string,
  durations: { timeoutMilliseconds: number; shutdownMilliseconds: number },
): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), "contract3-t05-"));
  const ledger = join(dir, "ledger");
  jest.useFakeTimers();
  const attached = programsAddon().attach(control());
  let result: ProgramResult | undefined;
  void attached.capability
    .inspect(shell(script(ledger), durations))
    .then((value) => {
      result = value;
    });
  const lines = () =>
    existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n") : [];
  const pid = (prefix: string) => {
    const line = lines().find((entry) => entry.startsWith(`${prefix} `));
    const value = line ? Number(line.split(" ")[1]) : Number.NaN;
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  return {
    ledger,
    lines,
    pid,
    outcome: () => result,
    async cleanup() {
      jest.useRealTimers();
      for (const prefix of ["child-started", "escaped"]) {
        const owned = pid(prefix);
        if (owned !== undefined)
          try {
            process.kill(owned, "SIGKILL");
          } catch {
            // Already gone.
          }
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Lets the add-on's 10 ms stop polling run until the result arrives.
async function resultArrives(started: Started) {
  const arrived = await until(() => {
    jest.advanceTimersByTime(pollLatency);
    return started.outcome() !== undefined;
  });
  if (!arrived) throw new Error("UNPROVED: the program result never arrived.");
  const result = started.outcome();
  const detail = result ? programDetails(result) : undefined;
  if (!result || !detail) throw new Error("UNPROVED: no program details.");
  return { result, detail };
}

const termTrapping = (ledger: string) =>
  `trap 'echo term-received >> ${ledger}; exit 0' TERM; echo "child-started $$" >> ${ledger}; while :; do /bin/sleep 0.05; done`;

async function timeoutExpiry(value: number) {
  const started = await startUnderFakeTime(termTrapping, {
    timeoutMilliseconds: value,
    shutdownMilliseconds: 2_000,
  });
  try {
    if (!(await until(() => started.pid("child-started") !== undefined)))
      throw new Error("UNPROVED: the child never started.");
    await advance(value - 1);
    // One millisecond before the timeout: no SIGTERM was sent.
    realPause(0.2);
    expect(started.lines()).not.toContain("term-received");
    expect(started.outcome()).toBeUndefined();
    await advance(1);
    const { detail } = await resultArrives(started);
    expect(started.lines()).toContain("term-received");
    expect(detail.timedOut).toBe(true);
    const [first] = detail.attempts;
    expect(first?.signal).toBe("SIGTERM");
    expect(first?.afterMilliseconds).toBeGreaterThanOrEqual(value);
    expect(first?.afterMilliseconds).toBeLessThanOrEqual(value + pollLatency);
  } finally {
    await started.cleanup();
  }
}

// The direct child exits at once; a writer in its own session keeps the
// stdout pipe, prints one line and holds it open for 60 s.
const heldPipe = (ledger: string) =>
  `echo "direct $$" >> ${ledger}; /usr/bin/perl -e 'use POSIX qw(setsid); pipe(my $r, my $w); my $p = fork(); if ($p == 0) { close $r; setsid(); open(my $f, ">>", "${ledger}"); print $f "escaped $$\\n"; close $f; close $w; close STDERR; $| = 1; print "FX-HELD-LINE\\n"; sleep 60; exit 0 } close $w; my $b; sysread($r, $b, 1); exit 0'`;

async function drainExpiry(value: number) {
  const started = await startUnderFakeTime(heldPipe, {
    timeoutMilliseconds: 3 * timerLimit,
    shutdownMilliseconds: value,
  });
  try {
    const direct = await until(() => {
      const pid = started.pid("direct");
      return started.pid("escaped") !== undefined && pid !== undefined
        ? !alive(pid)
        : false;
    });
    if (!direct) throw new Error("UNPROVED: the direct child never exited.");
    await turns(50);
    // The group was observed empty; only the drain timer is pending now.
    if (jest.getTimerCount() !== 1)
      throw new Error("UNPROVED: the drain timer was not the one timer.");
    await advance(value - 1);
    expect(started.outcome()).toBeUndefined();
    await advance(1);
    const { result, detail } = await resultArrives(started);
    expect(result.outputTruncated).toBe(true);
    expect(detail.stdoutTruncated).toBe(true);
    expect(result.stdout).toBe("FX-HELD-LINE\n");
  } finally {
    await started.cleanup();
  }
}

describe("T05 program timers expire only after a duration above the timer limit (finding 1)", () => {
  test(
    "T05.program-timers-expiry-above-limit timeout 3000000000",
    () => timeoutExpiry(3_000_000_000),
    timeout,
  );
  test(
    "T05.program-timers-expiry-above-limit drain 3000000000",
    () => drainExpiry(3_000_000_000),
    timeout,
  );
});

describe("T06 small program timers keep their exact timing (finding 1)", () => {
  test(
    "T06.small-values-unchanged program timeout 300",
    () => timeoutExpiry(300),
    timeout,
  );
  test(
    "T06.small-values-unchanged program drain 50",
    () => drainExpiry(50),
    timeout,
  );
});
