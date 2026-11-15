// T2 programs add-on process cases (P05 to P10). Starts, stdin reads and
// survivors come from the fixture ledger and the OS process table.
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { callerProgramDisclosure } from "../../../starters/contract3/src/addons/programs/index.ts";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import { assertEnvelope, receipt } from "../lifecycle/checks.ts";
import { sliceCases } from "../lifecycle/coverage.ts";
import {
  alive,
  cleanup,
  frontDoorStart,
  goneWithin,
  launch,
  launchCase,
  listing,
  n,
  processGroup,
  readLedger,
  requireTools,
  residentKilobytes,
  run,
  text,
} from "../lifecycle/harness.ts";
import type { Case, Launched, Observed } from "../lifecycle/harness.ts";

const timeout = 60_000;
// Same calibrated observation tolerance as the lifecycle cases.
const tolerance = 100;
// The one owned stream probe, also used by the fixture's isolation mode.
const streamProbe = join(import.meta.dir, "fixtures/stream-probe.sh");

function pidAfter(ledger: readonly string[], prefix: string) {
  const line = ledger.find((entry) => entry.startsWith(`${prefix} `));
  const pid = line ? Number(line.split(" ")[1]) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
function requirePid(ledger: readonly string[], prefix: string): number {
  const pid = pidAfter(ledger, prefix);
  if (pid === undefined) throw new Error(`No ${prefix} pid was ledgered.`);
  return pid;
}
function data(result: Record<string, unknown>) {
  if (!record(result.data)) throw new Error("Expected program data.");
  return result.data;
}
function kill(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
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

// P08 by case shape: a signal path, an envelope path and the crash path.
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

// First time the process table no longer shows `pid`, polled every 2 ms.
async function deathAfter(pid: number, from: number, limit: number) {
  while (Date.now() - from < limit) {
    if (!alive(pid)) return Date.now();
    await Bun.sleep(2);
  }
  return Number.POSITIVE_INFINITY;
}
// Polling and kill latency for that observation (baseline death ~305 ms).
const killObservationTolerance = 30;

const p08: Record<string, (entry: Case) => Promise<Observed>> = {
  "P08.first-signal": async (entry) => {
    const launched = await launchCase(entry);
    await launched.barrier("child-started");
    const child = requirePid(readLedger(launched.ledgerPath), "child-started");
    const sent = await signalSent(entry, launched);
    const died = await deathAfter(child, sent, 2_000);
    const observed = await launched.done;
    receipt(entry, observed, {
      signalToExitMilliseconds: observed.exitedAt - sent,
      signalToOwnedChildDeathMilliseconds: died - sent,
    });
    assertNoEnvelope(entry, observed);
    expect(observed.exitedAt - sent).toBeLessThanOrEqual(
      signalBound(entry) + tolerance,
    );
    // LIFE-11: SIGKILL reaches the TERM-ignoring child before the 500 ms
    // bound expires, observed independently in the process table.
    expect(died - sent).toBeLessThanOrEqual(
      signalBound(entry) + killObservationTolerance,
    );
    return observed;
  },
  "P08.repeated-signal": async (entry) => {
    const launched = await launchCase(entry);
    const sent = await signalSent(entry, launched);
    const observed = await launched.done;
    receipt(entry, observed, {
      signalToExitMilliseconds: observed.exitedAt - sent,
    });
    assertNoEnvelope(entry, observed);
    expect(observed.exitedAt - sent).toBeLessThanOrEqual(
      signalBound(entry) + tolerance,
    );
    return observed;
  },
  "P08.catchable-crash": async (entry) => {
    const observed = await run(entry);
    receipt(entry, observed);
    assertNoEnvelope(entry, observed);
    expect(
      observed.ledger.filter((line) => line.startsWith("emergency")).length,
    ).toBe(n(entry.expect.emergencyWrites));
    return observed;
  },
  "P08.deadline": async (entry) => {
    const observed = await run(entry);
    receipt(entry, observed);
    assertEnvelope(entry, observed);
    assertDeadlineLag(entry, observed);
    return observed;
  },
  "P08.normal-completion": async (entry) => {
    const observed = await run(entry);
    receipt(entry, observed);
    assertEnvelope(entry, observed);
    return observed;
  },
};

const checks: Record<string, (entry: Case) => Promise<void>> = {
  P05: isolation,
  async P06(entry) {
    const launched = await launchCase(entry);
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
    const observed = await launched.done;
    await sampling;
    receipt(entry, observed, { peakRssKilobytes: peak, samples });
    try {
      // A host whose ps cannot sample the CLI leaves memory unproved.
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
      await cleanup(observed);
    }
  },
  async P07(entry) {
    requireTools();
    const sentinel = Bun.spawn(["/bin/sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const launched = await launchCase(entry);
    await launched.barrier("grandchild");
    const cliGroup = processGroup(launched.pid);
    const observed = await launched.done;
    receipt(entry, observed, { cliGroup });
    const grandchild = pidAfter(observed.ledger, "grandchild");
    try {
      const { result } = assertEnvelope(entry, observed);
      const childGroup = pidAfter(observed.ledger, "child-pgid");
      expect(childGroup).toBeNumber();
      expect(cliGroup).toBeNumber();
      expect(childGroup).not.toBe(cliGroup);
      if (grandchild === undefined) throw new Error("No grandchild pid.");
      expect(await goneWithin(grandchild, 1000)).toBe(true);
      expect(alive(sentinel.pid)).toBe(true);
      const detail = data(result);
      expect(detail.attempts).toEqual(entry.expect.attempts);
      expect(detail.timedOut).toBe(true);
      expect(detail.terminationConfirmed).toBe(true);
    } finally {
      sentinel.kill("SIGKILL");
      kill(grandchild);
      await cleanup(observed);
    }
  },
  async P08(entry) {
    const shape = p08[entry.id];
    if (!shape) throw new Error(`No P08 shape for ${entry.id}.`);
    const observed = await shape(entry);
    const child = pidAfter(observed.ledger, "child-started");
    try {
      if (child === undefined) throw new Error("No owned child pid.");
      // The owned TERM-ignoring child is gone: a forced kill was attempted.
      expect(await goneWithin(child, 300)).toBe(true);
    } finally {
      kill(child);
      await cleanup(observed);
    }
  },
  // LIFE-11 excludes a cleanup guarantee here; it does not require
  // survivors. Survival is recorded as an observation, never asserted.
  async P09(entry) {
    if (entry.id === "P09.parent-sigkill") {
      const launched = await launchCase(entry);
      await launched.barrier("child-started");
      launched.signal("SIGKILL");
      const observed = await launched.done;
      const child = requirePid(observed.ledger, "child-started");
      await Bun.sleep(300);
      receipt(entry, observed, {
        ownedChildAliveAfterParentSigkill: alive(child),
      });
      try {
        expect(observed.signal).toBe("SIGKILL");
        expect(observed.stdout.byteLength).toBe(0);
      } finally {
        kill(child);
        await cleanup(observed);
      }
      return;
    }
    const launched = await launchCase(entry);
    const observed = await launched.done;
    const escaped = requirePid(readLedger(launched.ledgerPath), "escaped");
    receipt(entry, observed, { escapedAlive: alive(escaped) });
    try {
      // No result claims cleanup or undone effects: an inspect envelope.
      assertEnvelope(entry, observed);
    } finally {
      kill(escaped);
      await cleanup(observed);
    }
  },
  async P10(entry) {
    const launched = await launchCase(entry);
    const observed = await launched.done;
    receipt(entry, observed);
    try {
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
      await cleanup(observed);
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
        const observed = await (
          await launch({ argv: ["program", "--mode", mode, "--json"] })
        ).done;
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
      const observed = await (
        await launch({ argv: ["undisclosed", streamProbe, "--json"] })
      ).done;
      try {
        // No child started (the probe ledgers its stdin read when it runs)
        // and the command did not succeed.
        expect(
          observed.ledger.some((line) => line.startsWith("child-stdin-bytes")),
        ).toBe(false);
        expect(observed.code === 0).toBe(false);
        expect(observed.stderr.byteLength).toBe(0);
      } finally {
        await cleanup(observed);
      }
    },
    timeout,
  );
});
