import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  programDetails,
  programsAddon,
} from "../../../kernel/src/addons/programs/index.ts";
import type { ProgramResult } from "../../../kernel/src/kernel/index.ts";
import { alive, firstPid } from "../lifecycle/harness.ts";
import { overLimitBoundary, timerLimit } from "../lifecycle/oracle.ts";
import {
  advance,
  realPause,
  shell,
  turns,
  until,
} from "../lifecycle/recording-host.ts";
import { signalIfPresent } from "../../support/signal.ts";

const timeout = 30_000;
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

async function startUnderFakeTime(
  script: (ledger: string) => string,
  durations: { timeoutMilliseconds: number; shutdownMilliseconds: number },
): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), "kernel-t05-"));
  const ledger = join(dir, "ledger");
  jest.useFakeTimers();
  const attached = programsAddon().attach(control());
  let result: ProgramResult | undefined;
  let failure: unknown;
  void attached.capability.inspect(shell(script(ledger), durations)).then(
    (value) => {
      result = value;
    },
    (error: unknown) => {
      failure = error;
    },
  );
  const lines = () =>
    existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n") : [];
  const pid = (prefix: string) => firstPid(lines(), prefix);
  return {
    ledger,
    lines,
    pid,
    outcome: () => {
      if (failure !== undefined)
        throw new Error("The program request was rejected.", {
          cause: failure,
        });
      return result;
    },
    async cleanup() {
      jest.useRealTimers();
      for (const prefix of ["child-started", "escaped"]) {
        const owned = pid(prefix);
        if (owned !== undefined) signalIfPresent(owned, "SIGKILL");
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

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
    realPause(0.2);
    expect(started.lines()).not.toContain("term-received");
    expect(started.outcome()).toBeUndefined();
    await advance(1);
    const { detail } = await resultArrives(started);
    expect(started.lines()).toContain("term-received");
    expect(detail.timedOut).toBe(true);
    const [first] = detail.attempts;
    expect(first?.signal).toBe("SIGTERM");
    expect(first?.afterMilliseconds).toBe(value);
  } finally {
    await started.cleanup();
  }
}

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
    if (jest.getTimerCount() !== 1)
      throw new Error("UNPROVED: the drain timer was not the one timer.");
    await advance(value - 1);
    expect(started.outcome()).toBeUndefined();
    await advance(1);
    expect(await until(() => started.outcome() !== undefined)).toBe(true);
    const { result, detail } = await resultArrives(started);
    expect(result.outputTruncated).toBe(true);
    expect(detail.stdoutTruncated).toBe(true);
    expect(result.stdout).toBe("FX-HELD-LINE\n");
  } finally {
    await started.cleanup();
  }
}

describe("T05 program timers expire only after a duration above the timer limit (finding 1)", () => {
  for (const value of overLimitBoundary) {
    test(
      `T05.program-timers-expiry-above-limit timeout ${value}`,
      () => timeoutExpiry(value),
      timeout,
    );
    test(
      `T05.program-timers-expiry-above-limit drain ${value}`,
      () => drainExpiry(value),
      timeout,
    );
  }
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
