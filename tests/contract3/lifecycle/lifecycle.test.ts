// T2 lifecycle process cases (L01 to L05, L07 to L12, R02).
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { comparableEnvelope } from "../../../starters/contract3/src/kernel/comparison.ts";
import { assertEnvelope, authorityDefaults, receipt } from "./checks.ts";
import { sliceCases } from "./coverage.ts";
import {
  abortExitBound,
  abortTimeout,
  alive,
  caseById,
  cleanup,
  decliningHost,
  envelopeOf,
  exitBound,
  exitWithin,
  firstPid,
  frontDoorStart,
  goneWithin,
  launch,
  launchCase,
  listing,
  n,
  readLedger,
  release,
  resultOf,
  run,
  slowSmallChunkRun,
  spawnableLength,
  text,
} from "./harness.ts";
import type { Case, Launched, Observed, OperandFit } from "./harness.ts";
import {
  stopBound,
  supporting,
  timerLimit,
  unchangedEffects,
} from "./oracle.ts";

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
  return firstPid(observed.ledger, "child-started");
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
  const observed = await exitWithin(launched);
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

// B1 (Nathan, 16 November 2026): a command without deadline support refuses
// `--deadline-ms` under its own identity; a malformed value is refused by
// `<cli>.dispatch`. Test-owned binding table keyed by the frozen L07 IDs,
// which carry `identityPending` (t2-cases.json is not edited).
const l07Binding: Readonly<Record<string, string>> = {
  "L07.usage-unsupported-command": "fx.read",
  "L07.usage-zero": "fx.dispatch",
  "L07.usage-negative": "fx.dispatch",
  "L07.usage-non-integer": "fx.dispatch",
};

// K3-1 (swarm triage): the R02 mutations each frozen case must detect.
const r02Mutations: Readonly<Record<string, readonly string[]>> = {
  "R02.domain-difference-detected": [
    "data",
    "effects",
    "causeCode",
    "handoff-or-next",
  ],
};

const checks: Record<string, (entry: Case) => Promise<void>> = {
  async L01(entry) {
    const atDispatch = entry.expect.barrier === "dispatch-start";
    const launched = await start(entry, {
      env: atDispatch ? { FX_HOLD_MS: "400" } : {},
    });
    try {
      await launched.barrier(atDispatch ? "dispatch-start" : "child-started");
      const sent = launched.signal(signalName(entry.expect.signal));
      const observed = await finish(entry, launched);
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
      await release(launched);
    }
  },
  async L02(entry) {
    const launched = await start(entry, { reader: "pause-after-first" });
    try {
      await launched.partialRead;
      const sent = launched.signal(signalName(entry.expect.signal));
      const observed = await finish(entry, launched);
      // LIFE-3: the same 500 ms grace as a first signal before emission.
      expect(observed.exitedAt - sent).toBeLessThanOrEqual(500 + tolerance);
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(n(entry.expect.exit));
      expect(observed.stderr.byteLength).toBe(0);
      const raw = text(observed.stdout);
      expect(raw.split('{"contractVersion"').length - 1).toBe(1);
      expect(() => envelopeOf(observed.stdout)).toThrow();
    } finally {
      await release(launched);
    }
  },
  async L03(entry) {
    const launched = await start(entry);
    try {
      await launched.barrier("drained");
      launched.signal(signalName(entry.expect.signal));
      const observed = await finish(entry, launched);
      const { result } = assertEnvelope(entry, observed);
      expect(result.exitCode).toBe(entry.expect.envelopeExitCode);
    } finally {
      await release(launched);
    }
  },
  async L04(entry) {
    const signals = entry.expect.signals;
    if (!Array.isArray(signals)) throw new Error("L04 needs two signals.");
    const launched = await start(entry);
    try {
      await launched.barrier("child-started");
      launched.signal(signalName(signals[0]));
      await launched.barrier("child-term-received");
      const second = launched.signal(signalName(signals[1]));
      const observed = await finish(entry, launched);
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(n(entry.expect.exit));
      assertNoOutput(observed);
      expect(observed.exitedAt - second).toBeLessThanOrEqual(
        n(entry.expect.withinMillisecondsOfSecond) + tolerance,
      );
      const pid = childPid(observed);
      if (pid === undefined) throw new Error("No owned child pid.");
      expect(await goneWithin(pid, 1000)).toBe(true);
    } finally {
      await release(launched);
    }
  },
  async L05(entry) {
    const launched = await start(entry);
    try {
      const observed = await finish(entry, launched);
      expect(observed.signal).toBeNull();
      expect(observed.code).toBe(1);
      assertNoOutput(observed);
      expect(
        observed.ledger.filter((line) => line.startsWith("emergency")).length,
      ).toBe(n(entry.expect.emergencyWrites));
      const pid = childPid(observed);
      if (pid === undefined) throw new Error("No owned child pid.");
      expect(await goneWithin(pid, 1000)).toBe(true);
    } finally {
      await release(launched);
    }
  },
  async L07(entry) {
    const observed = await run(entry);
    receipt(entry, observed);
    try {
      const { result } = assertEnvelope(entry, observed);
      // B1: identities the frozen cases left pending are now asserted.
      if (entry.expect.identityPending === true) {
        const bound = l07Binding[entry.id];
        if (!bound) throw new Error(`${entry.id} has no B1 binding.`);
        expect(result.commandIdentity).toBe(bound);
      }
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
      // K3-1: the mutation list is a test-owned literal per frozen case, so
      // a missing or emptied frozen list fails instead of passing vacuously.
      const mutations = r02Mutations[entry.id] ?? [];
      expect(entry.expect.mutations ?? []).toEqual(mutations);
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

describe("L06 excluded terminations without T3 (supporting C7)", () => {
  for (const [id, scenario] of [
    ["L06s.abort", "abort"],
    ["L06s.hook-install-failure", "hook-install-fails"],
  ] as const)
    test(
      id,
      async () => {
        const entry = supporting(id, { argv: ["read", "--json"], scenario });
        const observed = await run(
          entry,
          {},
          scenario === "abort" ? abortExitBound : exitBound,
        );
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
      scenario === "abort" ? abortTimeout : timeout,
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
        // B3.02: the runtime denial carries the binding default words.
        expect({
          guidance: { handoff: result.handoff },
          repairAction: result.repairAction,
        }).toEqual(authorityDefaults);
        expect(result.data).toBeNull();
        expect(result.effects).toEqual({
          completed: [],
          remaining: [],
          uncertain: [],
          inventoryComplete: true,
        });
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

describe("B1 deadline refusal identity (Nathan, 16 November 2026)", () => {
  const usage = (id: string, argv: readonly string[], identity: string) =>
    supporting(id, {
      argv,
      expect: {
        commandIdentity: identity,
        causeCode: "USAGE_INVALID_INVOCATION",
      },
    });
  const cases = [
    // B1.01: the command without deadline support refuses under its identity.
    usage(
      "B1.01.option-after-route",
      ["read", "--deadline-ms", "100", "--json"],
      "fx.read",
    ),
    usage(
      "B1.01.option-before-route",
      ["--deadline-ms", "100", "read", "--json"],
      "fx.read",
    ),
    // B1.02: a malformed value is refused by dispatch, before command support.
    usage(
      "B1.02.zero",
      ["slow", "--deadline-ms", "0", "--json"],
      "fx.dispatch",
    ),
    usage(
      "B1.02.negative",
      ["slow", "--deadline-ms", "-5", "--json"],
      "fx.dispatch",
    ),
    usage(
      "B1.02.non-integer",
      ["slow", "--deadline-ms", "1.5", "--json"],
      "fx.dispatch",
    ),
    usage(
      "B1.02.word",
      ["slow", "--deadline-ms", "abc", "--json"],
      "fx.dispatch",
    ),
    usage("B1.02.missing", ["slow", "--json", "--deadline-ms"], "fx.dispatch"),
    usage(
      "B1.02.zero-on-unsupported",
      ["read", "--deadline-ms", "0", "--json"],
      "fx.dispatch",
    ),
    // B1.04: built-in routes. Bound by the coordinator's reading of B1
    // (today's behaviour, matching DISC-1's incompatible built-in options
    // row), reported to Nathan for confirmation.
    usage(
      "B1.04.help",
      ["--help", "--deadline-ms", "100", "--json"],
      "fx.dispatch",
    ),
    usage(
      "B1.04.discover",
      ["--discover", "--deadline-ms", "100", "--json"],
      "fx.dispatch",
    ),
    usage(
      "B1.04.discover-command",
      ["--discover-command", "fx.read", "--deadline-ms", "100", "--json"],
      "fx.dispatch",
    ),
  ];
  for (const entry of cases)
    test(
      entry.id,
      async () => {
        const observed = await run(entry);
        receipt(entry, observed);
        try {
          assertEnvelope(entry, observed);
          expect(observed.ledger.includes("dispatch-start")).toBe(false);
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );

  test(
    "B1.03.supported-command-twin",
    async () => {
      const entry = supporting("B1.03.supported", {
        argv: ["slow", "--deadline-ms", "1000", "--json"],
        expect: {
          commandIdentity: "fx.slow",
          causeCode: "DOMAIN_DEADLINE_UNCHANGED",
        },
      });
      const launched = await launchCase(entry);
      try {
        const observed = await finish(entry, launched);
        assertEnvelope(entry, observed);
        expect(observed.ledger).toContain("dispatch-start");
      } finally {
        await release(launched);
      }
    },
    timeout,
  );
});

describe("B3 declared denial tuple at runtime (Nathan, 16 November 2026)", () => {
  test(
    "B3.03.declared-tuple-overrides-at-runtime",
    async () => {
      const entry = supporting("B3.03.owned-denial", {
        argv: ["guarded-owned", "--go", "--json"],
        state: true,
        expect: {
          commandIdentity: "fx.guarded-owned",
          causeCode: "DOMAIN_AUTHORITY_REQUIRED",
        },
      });
      const observed = await run(entry, { env: { FX_APPROVAL: "deny" } });
      receipt(entry, observed);
      try {
        const { result } = assertEnvelope(entry, observed);
        // Test-owned literals: the fixture command's declared words.
        expect(result.handoff).toEqual({
          owner: "operator",
          reason: "The fixture desk must approve this item.",
          inspect: [
            { kind: "instruction", text: "Fixture desk: review the item." },
          ],
        });
        expect(result.repairAction).toBe(
          "Ask the fixture desk for an exact-item grant.",
        );
      } finally {
        await cleanup(observed);
      }
    },
    timeout,
  );
});

// Findings round, finding 1 (Nathan, 16 November 2026: every admitted value
// is honoured, no cap). LIMIT is the largest delay a runtime timer holds; a
// raw timer armed above it fires after about 1 ms with a stderr warning. The
// expectations are c3-expect-t2t5's (findings-round/expectations.md).
const handlerLines = new Set(["handler-entered", "handler-done"]);

describe("T01 a deadline above the timer limit lets the work finish (finding 1)", () => {
  for (const deadline of [
    timerLimit,
    timerLimit + 1,
    timerLimit + 60_000,
    3_000_000_000,
    Number.MAX_SAFE_INTEGER,
  ])
    test(
      `T01.deadline-above-limit-work-finishes D=${deadline}`,
      async () => {
        const entry = supporting("T01.deadline-above-limit-work-finishes", {
          argv: [
            "wait",
            "--wait-ms",
            "300",
            "--deadline-ms",
            String(deadline),
            "--json",
          ],
          expect: {
            commandIdentity: "fx.wait",
            causeCode: "SUCCESS_UNCHANGED",
            effects: unchangedEffects,
          },
        });
        const observed = await run(entry);
        receipt(entry, observed, { deadline });
        try {
          // One envelope at the handler's own station, exit 0, zero stderr.
          assertEnvelope(entry, observed);
          expect(observed.code).toBe(0);
          expect(
            observed.ledger.filter(
              (line) => handlerLines.has(line) || line.startsWith("stdout-"),
            ),
          ).toEqual(["handler-entered", "handler-done", "stdout-write result"]);
          expect(observed.firstStdoutAt).toBeNumber();
          expect(
            (observed.firstStdoutAt ?? 0) - frontDoorStart(observed),
          ).toBeGreaterThanOrEqual(300);
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );
});

describe("T02(a) a deadline above the timer limit that passed before dispatch (finding 1)", () => {
  for (const deadline of [3_000_000_000, Number.MAX_SAFE_INTEGER])
    test(
      `T02.deadline-above-limit-expiry-before-start D=${deadline}`,
      async () => {
        const entry = supporting(
          "T02.deadline-above-limit-expiry-before-start",
          {
            argv: [
              "wait",
              "--wait-ms",
              "300",
              "--deadline-ms",
              String(deadline),
              "--json",
            ],
            scenario: "clock-jump",
            expect: {
              commandIdentity: "fx.wait",
              causeCode: "DOMAIN_DEADLINE_BEFORE_START",
              effects: unchangedEffects,
            },
          },
        );
        // P3: the fault host's clock jumps past the deadline before dispatch.
        const observed = await run(entry, {
          env: { FX_CLOCK_JUMP_MS: String(deadline + 1) },
        });
        receipt(entry, observed, { deadline });
        try {
          assertEnvelope(entry, observed);
          expect(observed.code).toBe(3);
          expect(observed.ledger).not.toContain("handler-entered");
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );
});

// Finding 2. First time the process table no longer shows `pid`.
async function deathAfter(pid: number, from: number, limit: number) {
  while (Date.now() - from < limit) {
    if (!alive(pid)) return Date.now();
    await Bun.sleep(2);
  }
  return Number.POSITIVE_INFINITY;
}
// Polling and kill latency for that observation, as in P08.
const killObservationTolerance = 30;
const stopShapes = {
  // (a) the handler awaits a TERM-cooperative program.
  a: { argv: ["slow", "--json"], barrier: "child-started" },
  // (b) the handler returns by its own timer about 100 ms after the signal.
  b: {
    argv: ["wait", "--wait-ms", "100", "--json"],
    barrier: "handler-entered",
  },
  // (c) a TERM-ignoring program whose declared shutdown budget is 2,000 ms.
  c: { argv: ["slow", "--ignore-term", "--json"], barrier: "child-started" },
} as const;

describe("S01 the stop path's bounds hold when the handler returns in the window (finding 2)", () => {
  for (const [shape, setup] of Object.entries(stopShapes))
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const)
      test(
        `S01.stop-path-bounds-hold-when-handler-returns-in-window ${shape} ${signal}`,
        async () => {
          const entry = supporting(
            "S01.stop-path-bounds-hold-when-handler-returns-in-window",
            { argv: setup.argv },
          );
          const launched = await launchCase(entry);
          try {
            await launched.barrier(setup.barrier);
            const owned = firstPid(
              readLedger(launched.ledgerPath),
              "child-started",
            );
            const sent = launched.signal(signal);
            const died =
              owned === undefined
                ? undefined
                : await deathAfter(owned, sent, 2_000);
            const observed = await exitWithin(launched);
            receipt(entry, observed, {
              signalToExitMilliseconds: observed.exitedAt - sent,
              signalToOwnedChildDeathMilliseconds:
                died === undefined ? null : died - sent,
            });
            expect(observed.signal).toBeNull();
            expect(observed.code).toBe(code);
            assertNoOutput(observed);
            expect(observed.exitedAt - sent).toBeLessThanOrEqual(
              stopBound + tolerance,
            );
            expect(
              observed.ledger.some((line) => line.startsWith("late-start ")),
            ).toBe(false);
            if (shape !== "b") expect(owned).toBeNumber();
            // LIFE-11: the stop path's SIGKILL, not the 2,000 ms budget.
            if (died !== undefined)
              expect(died - sent).toBeLessThanOrEqual(
                stopBound + killObservationTolerance,
              );
          } finally {
            await release(launched);
          }
        },
        timeout,
      );
});

// N2 (round 3 confirmation): release() kills a ledgered pid only while it is
// still in the process group its ledger names. A pid the OS reused for an
// unrelated process (here, one in the test runner's own group) is spared.
test(
  "N2s.release-kills-only-pids-still-in-their-ledgered-group",
  async () => {
    const outside = Bun.spawn(["/bin/sleep", "30"]);
    const inside = Bun.spawn(["/bin/sleep", "30"], { detached: true });
    const launched = await launch({ argv: ["read", "--json"] });
    try {
      await exitWithin(launched);
      await appendFile(
        launched.ledgerPath,
        `child-started ${outside.pid}\nescaped ${inside.pid}\n`,
      );
      await release(launched);
      const ended = await Promise.race([
        inside.exited.then(() => inside.signalCode),
        Bun.sleep(2_000).then(() => "still running"),
      ]);
      expect(ended).toBe("SIGKILL");
      expect(alive(outside.pid)).toBe(true);
      expect(outside.exitCode).toBeNull();
    } finally {
      outside.kill("SIGKILL");
      inside.kill("SIGKILL");
    }
  },
  timeout,
);

// Contract review F2: the grandchild branch. A ledgered grandchild is killed
// only while it is still in the ledgered `child-pgid`; a pid outside it is
// spared.
test(
  "N2s.release-spares-a-grandchild-outside-the-ledgered-group",
  async () => {
    const outside = Bun.spawn(["/bin/sleep", "30"]);
    const group = Bun.spawn(
      ["/bin/sh", "-c", "/bin/sleep 30 >/dev/null & echo $!; wait"],
      { detached: true, stdout: "pipe" },
    );
    // The shell prints its background member's pid, then waits on it.
    const first = await group.stdout.getReader().read();
    const member = Number(new TextDecoder().decode(first.value).trim());
    const launched = await launch({ argv: ["read", "--json"] });
    try {
      expect(Number.isSafeInteger(member) && member > 0).toBe(true);
      await exitWithin(launched);
      await appendFile(
        launched.ledgerPath,
        `child-pgid ${group.pid}\ngrandchild ${member}\ngrandchild ${outside.pid}\n`,
      );
      await release(launched);
      expect(await goneWithin(member, 2_000)).toBe(true);
      expect(alive(outside.pid)).toBe(true);
      expect(outside.exitCode).toBeNull();
    } finally {
      outside.kill("SIGKILL");
      try {
        process.kill(-group.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  },
  timeout,
);

// Swarm triage, test honesty. K3-12: a CLI that exits while a descendant
// still holds its stdout gives an incomplete observation, and reading it
// fails as unproved instead of looking like empty output.
describe("test harness honesty (swarm triage K3-3, K3-12)", () => {
  const lateWriter =
    '/usr/bin/perl -e \'open(my $f, ">>", $ENV{FX_LEDGER}); print $f "late-writer $$\\n"; close $f; close STDERR; select(undef, undef, undef, 2.5); print "late-written\\n"\' &';
  for (const [variant, shell, complete] of [
    ["late writer", `${lateWriter} exit 0`, false],
    ["twin", "exit 0", true],
  ] as const)
    test(
      `K3-12.open-stdout-is-unproved ${variant}`,
      async () => {
        const launched = await launch({ argv: [], rawArgvShell: shell });
        try {
          const observed = await exitWithin(launched);
          expect(observed.code).toBe(0);
          expect(observed.stdoutComplete).toBe(complete);
          if (complete) expect(observed.stdout.byteLength).toBe(0);
          else expect(() => observed.stdout).toThrow("UNPROVED");
        } finally {
          const writer = firstPid(
            readLedger(launched.ledgerPath),
            "late-writer",
          );
          if (writer !== undefined)
            try {
              process.kill(writer, "SIGKILL");
            } catch {
              // Already gone.
            }
          await release(launched);
        }
      },
      timeout,
    );

  // K3-3: a CLI that never exits is released by the bounded wait itself.
  test(
    "K3-3.hang-releases-fixture",
    async () => {
      const launched = await launch({
        argv: [],
        rawArgvShell: "exec /bin/sleep 30",
      });
      const failure = await exitWithin(launched, 500).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure instanceof Error ? failure.message : "").toContain(
        "did not exit within 500 ms",
      );
      expect(await goneWithin(launched.pid, 1_000)).toBe(true);
      expect(await listing(launched.dir)).toEqual([]);
    },
    timeout,
  );
});
