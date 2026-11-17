import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { callerProgramDisclosure } from "../../../starters/contract3/src/addons/programs/index.ts";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import { assertEnvelope, receipt } from "../lifecycle/checks.ts";
import { sliceCases } from "../lifecycle/coverage.ts";
import {
  alive,
  firstPid,
  cleanup,
  exitWithin,
  frontDoorStart,
  goneWithin,
  launch,
  launchCase,
  listing,
  n,
  processGroup,
  readLedger,
  release as releaseLaunched,
  requireTools,
  residentKilobytes,
  run,
  text,
} from "../lifecycle/harness.ts";
import type { Case, Launched, Observed } from "../lifecycle/harness.ts";
import {
  killObservationTolerance,
  supporting,
  timerLimit,
  tolerance,
  unchangedEffects,
} from "../lifecycle/oracle.ts";

const timeout = 60_000;
const streamProbe = join(import.meta.dir, "fixtures/stream-probe.sh");

function requirePid(ledger: readonly string[], prefix: string): number {
  const pid = firstPid(ledger, prefix);
  if (pid === undefined) throw new Error(`No ${prefix} pid was ledgered.`);
  return pid;
}
function data(result: Record<string, unknown>) {
  if (!record(result.data)) throw new Error("Expected program data.");
  return result.data;
}
function withProbe(entry: Case): readonly string[] {
  return entry.argv.map((arg) =>
    arg === "<probe-script>" ? streamProbe : arg,
  );
}

async function isolation(entry: Case) {
  const marker = entry.expect.markerAbsent;
  if (typeof marker !== "string") throw new Error("P05 needs its marker.");
  const observed = await run(entry, { argv: withProbe(entry) });
  receipt(entry, observed);
  try {
    const { result } = assertEnvelope(entry, observed);
    expect(text(observed.stdout).includes(marker)).toBe(false);
    expect(observed.ledger).toContain("child-stdin-bytes 0");
    expect(data(result).markerSeen).toBe(true);
  } finally {
    await cleanup(observed);
  }
}

async function signalSent(entry: Case, launched: Launched): Promise<number> {
  await launched.barrier("child-started");
  const first = launched.signal("SIGTERM");
  if (entry.id !== "P08.repeated-signal") return first;
  await launched.barrier("child-term-received");
  return launched.signal("SIGINT");
}

function signalBound(entry: Case): number {
  const expected = entry.expect;
  return n(expected.withinMilliseconds ?? expected.withinMillisecondsOfSecond);
}

function assertNoEnvelope(entry: Case, observed: Observed) {
  expect(observed.signal).toBeNull();
  expect(observed.code).toBe(n(entry.expect.exit));
  expect(observed.stdout.byteLength).toBe(0);
  expect(observed.stderr.byteLength).toBe(0);
}

function assertDeadlineLag(entry: Case, observed: Observed) {
  const index = entry.argv.indexOf("--deadline-ms");
  const deadlineAt = frontDoorStart(observed) + Number(entry.argv[index + 1]);
  const lag = (observed.firstStdoutAt ?? Number.POSITIVE_INFINITY) - deadlineAt;
  expect(lag).toBeGreaterThanOrEqual(0);
  expect(lag).toBeLessThanOrEqual(
    n(entry.expect.withinMillisecondsAfterDeadline) + tolerance,
  );
}

async function deathAfter(pid: number, from: number, limit: number) {
  while (Date.now() - from < limit) {
    if (!alive(pid)) return Date.now();
    await Bun.sleep(2);
  }
  return Number.POSITIVE_INFINITY;
}

type Tracker = { launched?: Launched; observed?: Observed };
async function begin(entry: Case, tracker: Tracker) {
  tracker.launched = await launchCase(entry);
  return tracker.launched;
}
async function end(tracker: Tracker, launched: Launched) {
  tracker.observed = await exitWithin(launched);
  return tracker.observed;
}
async function release(tracker: Tracker) {
  if (tracker.launched) await releaseLaunched(tracker.launched);
}

const p08: Record<string, (entry: Case, tracker: Tracker) => Promise<void>> = {
  "P08.first-signal": async (entry, tracker) => {
    const launched = await begin(entry, tracker);
    await launched.barrier("child-started");
    const child = requirePid(readLedger(launched.ledgerPath), "child-started");
    const sent = await signalSent(entry, launched);
    const died = await deathAfter(child, sent, 2_000);
    const observed = await end(tracker, launched);
    receipt(entry, observed, {
      signalToExitMilliseconds: observed.exitedAt - sent,
      signalToOwnedChildDeathMilliseconds: died - sent,
    });
    assertNoEnvelope(entry, observed);
    expect(observed.exitedAt - sent).toBeLessThanOrEqual(
      signalBound(entry) + tolerance,
    );
    expect(died - sent).toBeLessThanOrEqual(
      signalBound(entry) + killObservationTolerance,
    );
  },
  "P08.repeated-signal": async (entry, tracker) => {
    const launched = await begin(entry, tracker);
    const sent = await signalSent(entry, launched);
    const observed = await end(tracker, launched);
    receipt(entry, observed, {
      signalToExitMilliseconds: observed.exitedAt - sent,
    });
    assertNoEnvelope(entry, observed);
    expect(observed.exitedAt - sent).toBeLessThanOrEqual(
      signalBound(entry) + tolerance,
    );
  },
  "P08.catchable-crash": async (entry, tracker) => {
    const observed = await end(tracker, await begin(entry, tracker));
    receipt(entry, observed);
    assertNoEnvelope(entry, observed);
    expect(
      observed.ledger.filter((line) => line.startsWith("emergency")).length,
    ).toBe(n(entry.expect.emergencyWrites));
  },
  "P08.deadline": async (entry, tracker) => {
    const observed = await end(tracker, await begin(entry, tracker));
    receipt(entry, observed);
    assertEnvelope(entry, observed);
    assertDeadlineLag(entry, observed);
  },
  "P08.normal-completion": async (entry, tracker) => {
    const observed = await end(tracker, await begin(entry, tracker));
    receipt(entry, observed);
    assertEnvelope(entry, observed);
  },
};

const checks: Record<string, (entry: Case) => Promise<void>> = {
  P05: isolation,
  async P06(entry) {
    const launched = await launchCase(entry);
    try {
      let peak = 0;
      let samples = 0;
      const sampling = (async () => {
        for (;;) {
          const rss = residentKilobytes(launched.pid);
          if (rss === undefined) return;
          samples += 1;
          peak = Math.max(peak, rss);
          await Bun.sleep(20);
        }
      })();
      const observed = await exitWithin(launched);
      await sampling;
      receipt(entry, observed, { peakRssKilobytes: peak, samples });
      expect(samples).toBeGreaterThan(0);
      const { result } = assertEnvelope(entry, observed);
      const captured = data(result);
      const limit = Number(entry.expect.capturedAtMost);
      expect(Number(captured.stdoutBytes)).toBeLessThanOrEqual(limit);
      expect(Number(captured.stderrBytes)).toBeLessThanOrEqual(limit);
      expect(captured.stdoutTruncated).toBe(true);
      expect(captured.stderrTruncated).toBe(true);
      expect(peak / 1024).toBeLessThanOrEqual(
        Number(entry.expect.maxRssMegabytes),
      );
      expect(await listing(join(observed.dir, "work"))).toEqual([]);
      expect(await listing(join(observed.dir, "tmp"))).toEqual([]);
    } finally {
      await releaseLaunched(launched);
    }
  },
  async P07(entry) {
    requireTools();
    const sentinel = Bun.spawn(["/bin/sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const launched = await launchCase(entry);
    try {
      await launched.barrier("grandchild");
      const cliGroup = processGroup(launched.pid);
      const observed = await exitWithin(launched);
      receipt(entry, observed, { cliGroup });
      const grandchild = requirePid(observed.ledger, "grandchild");
      const { result } = assertEnvelope(entry, observed);
      const childGroup = firstPid(observed.ledger, "child-pgid");
      expect(childGroup).toBeNumber();
      expect(cliGroup).toBeNumber();
      expect(childGroup).not.toBe(cliGroup);
      expect(await goneWithin(grandchild, 1000)).toBe(true);
      expect(alive(sentinel.pid)).toBe(true);
      const detail = data(result);
      expect(detail.attempts).toEqual(entry.expect.attempts);
      expect(detail.timedOut).toBe(true);
      expect(detail.terminationConfirmed).toBe(true);
    } finally {
      sentinel.kill("SIGKILL");
      await releaseLaunched(launched);
    }
  },
  async P08(entry) {
    const shape = p08[entry.id];
    if (!shape) throw new Error(`No P08 shape for ${entry.id}.`);
    const tracker: Tracker = {};
    try {
      await shape(entry, tracker);
      const observed = tracker.observed;
      if (!observed) throw new Error("The P08 shape observed no process.");
      const child = requirePid(observed.ledger, "child-started");
      expect(await goneWithin(child, 300)).toBe(true);
    } finally {
      await release(tracker);
    }
  },
  async P09(entry) {
    const launched = await launchCase(entry);
    try {
      if (entry.id === "P09.parent-sigkill") {
        await launched.barrier("child-started");
        launched.signal("SIGKILL");
        const observed = await exitWithin(launched);
        const child = requirePid(observed.ledger, "child-started");
        await Bun.sleep(300);
        receipt(entry, observed, {
          ownedChildAliveAfterParentSigkill: alive(child),
        });
        expect(observed.signal).toBe("SIGKILL");
        expect(observed.stdout.byteLength).toBe(0);
        return;
      }
      const observed = await exitWithin(launched);
      const escaped = requirePid(readLedger(launched.ledgerPath), "escaped");
      receipt(entry, observed, { escapedAlive: alive(escaped) });
      assertEnvelope(entry, observed);
    } finally {
      await releaseLaunched(launched);
    }
  },
  async P10(entry) {
    const launched = await launchCase(entry);
    try {
      const observed = await exitWithin(launched);
      receipt(entry, observed);
      const { result } = assertEnvelope(entry, observed);
      const command = data(result).command;
      expect(record(command)).toBe(true);
      if (!record(command)) return;
      expect(Object.keys(command).sort()).toEqual([
        "commandIdentity",
        "effectClass",
        "route",
        "summary",
      ]);
      expect(String(command.summary)).toContain(callerProgramDisclosure);
      expect(String(command.summary).toLowerCase()).toContain(
        "supplied by the caller",
      );
    } finally {
      await releaseLaunched(launched);
    }
  },
};

describe("T2 programs add-on process cases", () => {
  for (const entry of sliceCases("programs"))
    test(
      entry.id,
      async () => {
        const check = checks[entry.family];
        if (!check) throw new Error(`No check for ${entry.family}.`);
        await check(entry);
      },
      timeout,
    );
});

describe("ProgramResult reports truncation (supporting C6, not a frozen case)", () => {
  for (const [mode, truncated] of [
    ["capture", true],
    ["timeout", false],
  ] as const)
    test(
      `P06s.output-truncated-${String(truncated)}`,
      async () => {
        const observed = await exitWithin(
          await launch({ argv: ["program", "--mode", mode, "--json"] }),
        );
        try {
          expect(observed.code).toBe(0);
          const envelope: unknown = JSON.parse(text(observed.stdout));
          const result = record(envelope) ? envelope.result : undefined;
          const fields = record(result) ? data(result) : {};
          expect(fields.outputTruncated).toBe(truncated);
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );
});

describe("caller-program disclosure guard (supporting C3, not a frozen case)", () => {
  test(
    "P10s.undisclosed-command-starts-no-program",
    async () => {
      const observed = await exitWithin(
        await launch({ argv: ["undisclosed", streamProbe, "--json"] }),
      );
      try {
        assertEnvelope(
          {
            id: "P10s.undisclosed-command-starts-no-program",
            family: "P10s",
            status: "supporting",
            argv: ["undisclosed", streamProbe, "--json"],
            scenario: undefined,
            state: false,
            stdin: "closed",
            expect: {
              commandIdentity: "fx.undisclosed",
              causeCode: "INTERNAL_RESULT_UNCHANGED",
              fallback: true,
            },
            supplier: undefined,
            note: undefined,
          },
          observed,
        );
        expect(observed.ledger).toContain("attach programs");
        expect(
          observed.ledger.some((line) => line.startsWith("child-stdin-bytes")),
        ).toBe(false);
      } finally {
        await cleanup(observed);
      }
    },
    timeout,
  );
});

const overLimit = [
  timerLimit,
  timerLimit + 1,
  3_000_000_000,
  Number.MAX_SAFE_INTEGER,
] as const;
function programCase(id: string, argv: readonly string[]): Case {
  return supporting(id, {
    argv,
    expect: {
      commandIdentity: "fx.program",
      causeCode: "SUCCESS_UNCHANGED",
      effects: unchangedEffects,
    },
  });
}
async function programRun(entry: Case) {
  const launched = await launchCase(entry);
  try {
    const observed = await exitWithin(launched);
    receipt(entry, observed);
    const { result } = assertEnvelope(entry, observed);
    return { fields: data(result), ledger: observed.ledger };
  } finally {
    await releaseLaunched(launched);
  }
}

describe("T03 a program timeout above the timer limit (finding 1)", () => {
  for (const value of overLimit)
    test(
      `T03.program-timeout-above-limit T=${value}`,
      async () => {
        const { fields, ledger } = await programRun(
          programCase("T03.program-timeout-above-limit", [
            "program",
            "--mode",
            "term-trap-sleeper",
            "--timeout-ms",
            String(value),
            "--json",
          ]),
        );
        expect(fields.exitCode).toBe(0);
        expect(fields.terminationConfirmed).toBe(true);
        expect(fields.outputTruncated).toBe(false);
        expect(fields.timedOut).toBe(false);
        expect(fields.attempts).toEqual([]);
        expect(ledger).toContain("child-done");
        expect(ledger).not.toContain("term-received");
      },
      timeout,
    );
});

const drainPattern = Array.from(
  { length: 10 },
  (_, index) =>
    `FX-DRAIN-${String(index).padStart(2, "0")}-${"d".repeat(187)}\n`,
).join("");
const drainHash = new Bun.CryptoHasher("sha256")
  .update(drainPattern)
  .digest("hex");

describe("T04 an output-drain budget above the timer limit (finding 1)", () => {
  for (const value of overLimit)
    test(
      `T04.drain-timer-above-limit S=${value}`,
      async () => {
        const { fields, ledger } = await programRun(
          programCase("T04.drain-timer-above-limit", [
            "program",
            "--mode",
            "escaped-writer",
            "--shutdown-ms",
            String(value),
            "--json",
          ]),
        );
        expect(ledger.some((line) => line.startsWith("escaped "))).toBe(true);
        expect(fields.stdoutBytes).toBe(drainPattern.length);
        expect(fields.stdoutSha256).toBe(drainHash);
        expect(fields.outputTruncated).toBe(false);
      },
      timeout,
    );
});
