// T2 lifecycle process cases (L01 to L05, L07 to L12, R02).
import { describe, expect, test } from "bun:test";
import { comparableEnvelope } from "../../../starters/contract3/src/kernel/comparison.ts";
import { assertEnvelope, receipt } from "./checks.ts";
import { sliceCases } from "./coverage.ts";
import {
  caseById,
  cleanup,
  decliningHost,
  envelopeOf,
  frontDoorStart,
  goneWithin,
  launch,
  launchCase,
  n,
  resultOf,
  run,
  slowSmallChunkRun,
  spawnableLength,
  text,
} from "./harness.ts";
import type { Case, Launched, Observed, OperandFit } from "./harness.ts";

const timeout = 30_000;
// Harness observation tolerance added to every contract bound. Calibrated
// from receipts: process exit observation adds about 2 to 20 ms on this host
// (L01 exits 10 to 20 ms after the signal; spawn to front-door start 20 to
// 40 ms is excluded by the ledgered front-door clock). 100 ms keeps a
// first-signal exit at 650 ms or a 1,000 ms deadline wait RED.
const tolerance = 100;

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
  extra: Partial<Parameters<typeof launch>[0]> = {},
) {
  return launchCase(entry, extra);
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

// LIFE-6: emission starts at most 500 ms after the deadline, measured from
// the fixture's ledgered front-door start (the deadline's own origin).
function assertDeadlineLag(entry: Case, observed: Observed) {
  const deadlineAt = frontDoorStart(observed) + deadlineOf(entry);
  const emitted = observed.firstStdoutAt;
  expect(emitted).toBeNumber();
  const lag = (emitted ?? Number.POSITIVE_INFINITY) - deadlineAt;
  expect(lag).toBeGreaterThanOrEqual(0);
  expect(lag).toBeLessThanOrEqual(
    n(entry.expect.withinMillisecondsAfterDeadline) + tolerance,
  );
}

function longestArgument(argv: readonly string[]): number {
  return argv.reduce(
    (best, arg, index) =>
      arg.length > (argv[best]?.length ?? 0) ? index : best,
    0,
  );
}

// H1: a frozen operand longer than the host can spawn is reported, never
// silently shortened: the lengths go to stderr in the test log and to the
// receipt. The case still asserts its frozen observation at the exercised
// length, which must stay above the 64 KiB input bound to mean "very long".
const veryLongFloor = 65_537;
function reportOperandFit(entry: Case, fit: OperandFit) {
  if (fit.refusedLength === null) return;
  process.stderr.write(
    `${entry.id}: the OS refused the frozen ${fit.refusedLength}-byte operand (shortest refused ${String(fit.shortestRefusedLength)} bytes); exercised ${fit.exercisedLength} bytes.\n`,
  );
  if (fit.exercisedLength < veryLongFloor)
    throw new Error(
      `UNPROVED on this host: the longest spawnable operand is ${fit.exercisedLength} bytes.`,
    );
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
    const sent = launched.signal(signalName(entry.expect.signal));
    const observed = await finish(entry, launched);
    try {
      // LIFE-3: the same 500 ms grace as a first signal before emission.
      expect(observed.exitedAt - sent).toBeLessThanOrEqual(500 + tolerance);
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
      assertDeadlineLag(entry, observed);
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
    // No hard drain bound exists (LIFE-6): only the test timeout limits it.
    const { observed, reads } = await slowSmallChunkRun(entry);
    receipt(entry, observed, { reads });
    try {
      assertEnvelope(entry, observed);
      expect(reads).toBeGreaterThanOrEqual(
        Math.floor(n(entry.expect.minimumBytes) / 4096),
      );
    } finally {
      await cleanup(observed);
    }
  },
  async L12(entry) {
    const rawShell = entry.id === "L12.invalid-utf8-operand";
    const longest = longestArgument(entry.argv);
    const launched = await start(
      entry,
      rawShell
        ? {
            rawArgvShell: 'exec "$0" "$1" read "$(printf "\\377\\376")" --json',
          }
        : { fitOperand: longest },
    );
    const observed = await finish(entry, launched, {
      operand: launched.operand ?? null,
    });
    try {
      const fit = launched.operand;
      if (fit) reportOperandFit(entry, fit);
      const raw = (entry.argv[longest] ?? "").slice(
        0,
        fit?.exercisedLength ?? undefined,
      );
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

// Supporting cases with their own identities (not in the frozen case file).
function supporting(
  id: string,
  fields: Partial<Omit<Case, "id" | "family" | "status">>,
): Case {
  return {
    id,
    family: id.split(".")[0] ?? id,
    status: "supporting",
    argv: [],
    scenario: undefined,
    state: false,
    stdin: "closed",
    expect: {},
    supplier: undefined,
    note: undefined,
    ...fields,
  };
}

describe("L06 excluded terminations without T3 (supporting C7)", () => {
  for (const [id, scenario] of [
    ["L06s.abort", "abort"],
    ["L06s.hook-install-failure", "hook-install-fails"],
  ] as const)
    test(
      id,
      async () => {
        const entry = supporting(id, { argv: ["read", "--json"], scenario });
        const observed = await run(entry);
        // Host or runtime dependent exit: recorded, not asserted (lifecycle
        // table row 8). The required observation is the missing envelope.
        receipt(entry, observed);
        try {
          expect(observed.stdout.byteLength).toBe(0);
          expect(observed.code === 0).toBe(false);
          if (scenario === "abort") expect(observed.signal).toBe("SIGABRT");
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );
});

describe("CMD-9 steps 3 to 6 order (supporting C2)", () => {
  test(
    "C2s.future-binding-refused-before-deadline",
    async () => {
      for (const [item, causeCode] of [
        ["beta", "USAGE_INVALID_INVOCATION"],
        ["alpha", "DOMAIN_DEADLINE_BEFORE_START"],
      ] as const) {
        const entry = supporting(`C2s.binding-${item}`, {
          argv: ["source", item, "--deadline-ms", "1000", "--json"],
          scenario: "clock-jump",
          expect: { commandIdentity: "fx.source", causeCode },
        });
        const observed = await run(entry);
        receipt(entry, observed);
        try {
          assertEnvelope(entry, observed);
          expect(observed.ledger).not.toContain("dispatch-start");
        } finally {
          await cleanup(observed);
        }
      }
    },
    timeout,
  );

  test(
    "C2s.approval-denied-attaches-only-approval",
    async () => {
      const entry = supporting("C2s.approval-denied", {
        argv: ["guarded", "--go", "--json"],
        state: true,
        expect: {
          commandIdentity: "fx.guarded",
          causeCode: "DOMAIN_AUTHORITY_REQUIRED",
        },
      });
      const observed = await run(entry, { env: { FX_APPROVAL: "deny" } });
      receipt(entry, observed);
      try {
        const { result } = assertEnvelope(entry, observed);
        const handoff = result.handoff;
        expect(handoff).toMatchObject({ owner: "human" });
        expect(observed.ledger).toContain("attach approval");
        expect(observed.ledger).not.toContain("attach programs");
        expect(
          observed.ledger.some(
            (line) =>
              line.startsWith("guarded-child") || line.startsWith("applied"),
          ),
        ).toBe(false);
      } finally {
        await cleanup(observed);
      }
    },
    timeout,
  );

  test(
    "C2s.approval-granted-attaches-programs-on-use",
    async () => {
      const entry = supporting("C2s.approval-granted", {
        argv: ["guarded", "--go", "--json"],
        state: true,
        expect: {
          commandIdentity: "fx.guarded",
          causeCode: "SUCCESS_COMPLETED",
        },
      });
      const observed = await run(entry, { env: { FX_APPROVAL: "grant" } });
      receipt(entry, observed);
      try {
        assertEnvelope(entry, observed);
        const at = (prefix: string) =>
          observed.ledger.findIndex((line) => line.startsWith(prefix));
        expect(at("attach approval")).toBeGreaterThanOrEqual(0);
        expect(at("attach approval")).toBeLessThan(at("attach programs"));
        expect(at("attach programs")).toBeLessThan(at("guarded-child"));
        expect(at("guarded-child")).toBeLessThan(at("applied fx.alpha"));
      } finally {
        await cleanup(observed);
      }
    },
    timeout,
  );
});

describe("host argument limits (supporting H1)", () => {
  test(
    "H1s.long-operand-shortened-and-reported-under-a-small-budget",
    async () => {
      // Nine 100 KB variables leave Darwin about 150 KB of its 1 MB total
      // and stay inside Linux's per-string and total limits, so the frozen
      // 200,000-byte operand is refused on both and the case is shortened.
      const entry = caseById("L12.long-operand");
      const pad = Object.fromEntries(
        Array.from({ length: 9 }, (_unused, index) => [
          `FX_PAD_${index}`,
          "p".repeat(100_000),
        ]),
      );
      const launched = await launchCase(entry, { fitOperand: 1, env: pad });
      const observed = await finish(entry, launched, {
        operand: launched.operand ?? null,
      });
      try {
        const fit = launched.operand;
        if (!fit) throw new Error("The operand was not fitted.");
        expect(fit.refusedLength).toBe(200_000);
        expect(fit.exercisedLength).toBeLessThan(200_000);
        reportOperandFit(entry, fit);
        assertEnvelope(entry, observed);
        expect(text(observed.stdout).includes("L".repeat(64))).toBe(false);
      } finally {
        await cleanup(observed);
      }
    },
    timeout,
  );

  test(
    "H1s.spawnable-length-probe-finds-the-host-limit",
    () => {
      // 4 MB exceeds Darwin's total ARG_MAX and Linux's 131,072-byte limit on
      // one argument, so every supported host takes the shortening path.
      const env = { PATH: "/usr/bin:/bin" };
      const build = (length: number) => ["probe", "L".repeat(length)];
      const wanted = 4_000_000;
      const fits = spawnableLength(build, env, wanted);
      expect(fits).toBeLessThan(wanted);
      expect(fits).toBeGreaterThanOrEqual(65_537);
      const spawn = (length: number) =>
        Bun.spawnSync(["/bin/sh", "-c", ":", ...build(length)], {
          env,
          stdout: "ignore",
          stderr: "ignore",
        }).success;
      expect(spawn(fits)).toBe(true);
      expect(() => spawn(fits + 1)).toThrow();
    },
    timeout,
  );
});

describe("front-door timers and listeners in one process (supporting F6)", () => {
  test(
    "F6s.declining-host-runs-twice-without-stale-timers-or-listeners",
    async () => {
      const launched = await launch({ argv: [], script: decliningHost });
      // The deadline is 60 s; a timer left armed would hold the process open.
      const finished = await Promise.race([
        launched.done,
        Bun.sleep(10_000).then(() => undefined),
      ]);
      if (!finished) {
        launched.signal("SIGKILL");
        await cleanup(await launched.done);
        throw new Error("A stale timer kept the process alive for 10 s.");
      }
      try {
        expect(finished.code).toBe(0);
        expect(finished.stderr.byteLength).toBe(0);
        expect(
          finished.ledger.filter((line) => line === "declined-exit 0").length,
        ).toBe(2);
        expect(finished.ledger).toContain(
          "listeners SIGINT=1 SIGTERM=1 uncaughtException=1 unhandledRejection=1",
        );
      } finally {
        await cleanup(finished);
      }
    },
    timeout,
  );
});
