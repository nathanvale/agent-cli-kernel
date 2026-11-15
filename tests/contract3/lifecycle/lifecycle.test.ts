// T2 lifecycle process cases (L01 to L05, L07 to L12, R02).
import { describe, expect, test } from "bun:test";
import { comparableEnvelope } from "../../../starters/contract3/src/kernel/index.ts";
import { assertEnvelope, receipt } from "./checks.ts";
import { sliceCases } from "./coverage.ts";
import {
  cleanup,
  envelopeOf,
  goneWithin,
  launch,
  n,
  resultOf,
  run,
  text,
} from "./harness.ts";
import type { Case, Launched, Observed, Reader } from "./harness.ts";

const timeout = 30_000;
// Harness scheduling tolerance added to every contract bound.
const tolerance = 200;
// Process start to front-door start is not independently observable; this
// allowance bounds it for deadline timing (recorded with each receipt).
const startupAllowance = 600;

type Signal = "SIGINT" | "SIGTERM";
function signalName(value: unknown): Signal {
  if (value === "SIGINT" || value === "SIGTERM") return value;
  throw new Error("Expected a stop signal.");
}
function childPid(observed: { readonly ledger: readonly string[] }) {
  const line = observed.ledger.find((entry) =>
    entry.startsWith("child-started"),
  );
  return line ? Number(line.split(" ")[1]) : undefined;
}
function deadlineOf(entry: Case) {
  const index = entry.argv.indexOf("--deadline-ms");
  return Number(entry.argv[index + 1]);
}
async function start(
  entry: Case,
  extra: Parameters<typeof launch>[0] | object = {},
) {
  return launch({
    argv: entry.argv,
    state: entry.state,
    scenario: entry.scenario,
    stdin: entry.stdin,
    ...extra,
  });
}
async function finish(entry: Case, launched: Launched, extra: object = {}) {
  const observed = await launched.done;
  receipt(entry, observed, extra);
  return observed;
}
function assertNoOutput(observed: Observed) {
  expect(observed.stdout.byteLength).toBe(0);
  expect(observed.stderr.byteLength).toBe(0);
}

const checks: Record<string, (entry: Case) => Promise<void>> = {
  async L01(entry) {
    const atDispatch = entry.expect.barrier === "dispatch-start";
    const launched = await start(entry, {
      env: atDispatch ? { FX_HOLD_MS: "400" } : {},
    });
    await launched.barrier(atDispatch ? "dispatch-start" : "child-started");
    const sent = launched.signal(signalName(entry.expect.signal));
    const observed = await finish(entry, launched);
    try {
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(n(entry.expect.exit));
      assertNoOutput(observed);
      expect(observed.exitedAt - sent).toBeLessThanOrEqual(500 + tolerance);
      expect(
        observed.ledger.some((line) => line.startsWith("late-start ")),
      ).toBe(false);
      if (atDispatch)
        expect(
          observed.ledger.some((line) => line.startsWith("child-started")),
        ).toBe(false);
    } finally {
      await cleanup(observed);
    }
  },
  async L02(entry) {
    const launched = await start(entry, { reader: "pause-after-first" });
    await launched.partialRead;
    launched.signal(signalName(entry.expect.signal));
    const observed = await finish(entry, launched);
    try {
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(n(entry.expect.exit));
      expect(observed.stderr.byteLength).toBe(0);
      const raw = text(observed.stdout);
      expect(raw.split('{"contractVersion"').length - 1).toBe(1);
      expect(() => envelopeOf(observed.stdout)).toThrow();
    } finally {
      await cleanup(observed);
    }
  },
  async L03(entry) {
    const launched = await start(entry);
    await launched.barrier("drained");
    launched.signal(signalName(entry.expect.signal));
    const observed = await finish(entry, launched);
    try {
      const { result } = assertEnvelope(entry, observed);
      expect(result.exitCode).toBe(entry.expect.envelopeExitCode);
    } finally {
      await cleanup(observed);
    }
  },
  async L04(entry) {
    const signals = entry.expect.signals;
    if (!Array.isArray(signals)) throw new Error("L04 needs two signals.");
    const launched = await start(entry);
    await launched.barrier("child-started");
    launched.signal(signalName(signals[0]));
    await launched.barrier("child-term-received");
    const second = launched.signal(signalName(signals[1]));
    const observed = await finish(entry, launched);
    try {
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(n(entry.expect.exit));
      assertNoOutput(observed);
      expect(observed.exitedAt - second).toBeLessThanOrEqual(
        Number(entry.expect.withinMillisecondsOfSecond) + tolerance,
      );
      const pid = childPid(observed);
      expect(pid).toBeNumber();
      expect(await goneWithin(pid ?? 0, 1000)).toBe(true);
    } finally {
      await cleanup(observed);
    }
  },
  async L05(entry) {
    const observed = await run(entry);
    receipt(entry, observed);
    try {
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(1);
      assertNoOutput(observed);
      expect(
        observed.ledger.filter((line) => line.startsWith("emergency")).length,
      ).toBe(n(entry.expect.emergencyWrites));
      const pid = childPid(observed);
      expect(pid).toBeNumber();
      expect(await goneWithin(pid ?? 0, 1000)).toBe(true);
    } finally {
      await cleanup(observed);
    }
  },
  async L07(entry) {
    const observed = await run(entry);
    receipt(entry, observed);
    try {
      assertEnvelope(entry, observed);
      expect(observed.ledger.includes("dispatch-start")).toBe(false);
    } finally {
      await cleanup(observed);
    }
  },
  async L08(entry) {
    const launched = await start(entry);
    const observed = await finish(entry, launched);
    try {
      assertEnvelope(entry, observed);
      const deadline = deadlineOf(entry);
      const emitted = (observed.firstStdoutAt ?? Infinity) - observed.spawnedAt;
      expect(emitted).toBeGreaterThanOrEqual(deadline);
      expect(emitted - deadline).toBeLessThanOrEqual(
        Number(entry.expect.withinMillisecondsAfterDeadline) +
          startupAllowance +
          tolerance,
      );
      expect(
        observed.ledger.some((line) => line.startsWith("late-start ")),
      ).toBe(false);
    } finally {
      await cleanup(observed);
    }
  },
  async L09(entry) {
    const reader = entry.expect.reader;
    const launched = await start(entry, {
      reader:
        reader === "closed-at-start"
          ? "closed-at-start"
          : "close-after-first-chunk",
    });
    const observed = await finish(entry, launched);
    try {
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(1);
      expect(observed.stderr.byteLength).toBe(0);
      if (entry.expect.stdout === "empty")
        expect(observed.stdout.byteLength).toBe(0);
      else {
        expect(observed.stdout.byteLength).toBeGreaterThan(0);
        expect(() => envelopeOf(observed.stdout)).toThrow();
      }
    } finally {
      await cleanup(observed);
    }
  },
  async L10(entry) {
    const launched = await start(entry, { reader: "close-after-envelope" });
    const observed = await finish(entry, launched);
    try {
      expect(observed.ledger.some((line) => line.startsWith("drained"))).toBe(
        true,
      );
      assertEnvelope(entry, observed);
    } finally {
      await cleanup(observed);
    }
  },
  async L11(entry) {
    const launched = await start(entry, {
      reader: "slow-chunks" satisfies Reader,
    });
    const observed = await finish(entry, launched);
    try {
      assertEnvelope(entry, observed);
    } finally {
      await cleanup(observed);
    }
  },
  async L12(entry) {
    const raw = entry.argv[1] ?? "";
    const launched = await start(
      entry,
      entry.id === "L12.invalid-utf8-operand"
        ? {
            rawArgvShell: 'exec "$0" "$1" read "$(printf "\\377\\376")" --json',
          }
        : {},
    );
    const observed = await finish(entry, launched);
    try {
      assertEnvelope(entry, observed);
      if (entry.expect.noEcho === true) {
        const out = text(observed.stdout);
        expect(out.includes(raw)).toBe(false);
        expect(out.includes(JSON.stringify(raw).slice(1, -1))).toBe(false);
        expect(out.includes(raw.slice(0, 64))).toBe(false);
      }
    } finally {
      await cleanup(observed);
    }
  },
  async R02(entry) {
    const first = await run(entry);
    const second = await run(entry);
    receipt(entry, first);
    try {
      assertEnvelope(entry, first);
      assertEnvelope(entry, second);
      const a = envelopeOf(first.stdout);
      const b = envelopeOf(second.stdout);
      expect(resultOf(a).runId).not.toBe(resultOf(b).runId);
      expect(comparableEnvelope(a)).toBeString();
      expect(comparableEnvelope(a)).toBe(comparableEnvelope(b));
      // Independent normalisation: only the run identity differs.
      expect({ ...a, result: { ...resultOf(a), runId: "" } }).toEqual({
        ...b,
        result: { ...resultOf(b), runId: "" },
      });
      const mutations = entry.expect.mutations;
      if (Array.isArray(mutations))
        for (const mutation of mutations) {
          const changed = structuredClone(b);
          const result = resultOf(changed);
          if (mutation === "data") result.data = { text: "y" };
          if (mutation === "effects")
            result.effects = {
              completed: [],
              remaining: ["fx.other"],
              uncertain: [],
              inventoryComplete: true,
            };
          if (mutation === "causeCode") result.causeCode = "SUCCESS_COMPLETED";
          if (mutation === "handoff-or-next")
            result.next = { kind: "instruction", text: "Other." };
          expect(comparableEnvelope(changed)).not.toBe(comparableEnvelope(a));
        }
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  },
};

describe("T2 lifecycle process cases", () => {
  for (const entry of sliceCases("lifecycle"))
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
