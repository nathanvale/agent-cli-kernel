import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { comparableEnvelope } from "../../../starters/contract3/src/kernel/comparison.ts";
import { assertEnvelope, authorityDefaults, receipt } from "./checks.ts";
import type { Evidence } from "./checks.ts";
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
  killObservationTolerance,
  stopBound,
  supporting,
  timerLimit,
  tolerance,
  unchangedEffects,
} from "./oracle.ts";
import { signalGroupIfPresent, signalIfPresent } from "../../support/signal.ts";

const timeout = 30_000;

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
async function finish(entry: Case, launched: Launched, extra: Evidence = {}) {
  const observed = await exitWithin(launched);
  receipt(entry, observed, extra);
  return observed;
}
function assertNoOutput(observed: Observed) {
  expect(observed.stdout.byteLength).toBe(0);
  expect(observed.stderr.byteLength).toBe(0);
}

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

const l07Binding: Readonly<Record<string, string>> = {
  "L07.usage-unsupported-command": "fx.read",
  "L07.usage-zero": "fx.dispatch",
  "L07.usage-negative": "fx.dispatch",
  "L07.usage-non-integer": "fx.dispatch",
};

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
      expect({ ...a, result: { ...resultOf(a), runId: "" } }).toEqual({
        ...b,
        result: { ...resultOf(b), runId: "" },
      });
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
        // B3.02: the runtime denial carries the default station words (accepted decision B3).
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
      // Platform: Nine 100 KB variables leave Darwin about 150 KB of its 1 MB total
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
      // Platform: 4 MB exceeds Darwin's total ARG_MAX and Linux's 131,072-byte limit on
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
    // B1.04: built-in routes. Set by accepted decision B1
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

describe("T02(a) a deadline above the timer limit that passed before handler entry (finding 1)", () => {
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

async function deathAfter(pid: number, from: number, limit: number) {
  while (Date.now() - from < limit) {
    if (!alive(pid)) return Date.now();
    await Bun.sleep(2);
  }
  return Number.POSITIVE_INFINITY;
}
const stopShapes = {
  a: { argv: ["slow", "--json"], barrier: "child-started" },
  b: {
    argv: ["wait", "--wait-ms", "100", "--json"],
    barrier: "handler-entered",
  },
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

test(
  "N2s.release-spares-a-grandchild-outside-the-ledgered-group",
  async () => {
    const outside = Bun.spawn(["/bin/sleep", "30"]);
    const group = Bun.spawn(
      ["/bin/sh", "-c", "/bin/sleep 30 >/dev/null & echo $!; wait"],
      { detached: true, stdout: "pipe" },
    );
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
      signalGroupIfPresent(group.pid, "SIGKILL");
    }
  },
  timeout,
);

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
          if (writer !== undefined) signalIfPresent(writer, "SIGKILL");
          await release(launched);
        }
      },
      timeout,
    );

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

test(
  "K3S3.deadline-bounds-post-handler-settle",
  async () => {
    const entry = supporting("K3S3.deadline-bounds-post-handler-settle", {
      argv: ["spawn-return", "--deadline-ms", "300", "--json"],
      expect: {
        commandIdentity: "fx.spawn-return",
        causeCode: "DOMAIN_DEADLINE_UNCHANGED",
        effects: unchangedEffects,
        withinMillisecondsAfterDeadline: 500,
      },
    });
    const launched = await launchCase(entry);
    try {
      await launched.barrier("child-started");
      const child = firstPid(readLedger(launched.ledgerPath), "child-started");
      if (child === undefined) throw new Error("UNPROVED: no owned child.");
      const died = await deathAfter(child, launched.spawnedAt, 10_000);
      const observed = await exitWithin(launched);
      receipt(entry, observed, { childDiedAt: died });
      assertEnvelope(entry, observed);
      assertDeadlineLag(entry, observed);
      const order = observed.ledger.filter(
        (line) =>
          line === "child-term-received" || line.startsWith("stdout-write"),
      );
      expect(order).toEqual(["child-term-received", "stdout-write result"]);
      expect(died).toBeLessThanOrEqual(
        (observed.firstStdoutAt ?? 0) + killObservationTolerance,
      );
    } finally {
      await release(launched);
    }
  },
  timeout,
);

test(
  "K3S3b.post-handler-bound-near-deadline",
  async () => {
    const entry = supporting("K3S3b.post-handler-bound-near-deadline", {
      argv: [
        "spawn-return",
        "--slow-term",
        "--return-after-ms",
        "300",
        "--deadline-ms",
        "500",
        "--json",
      ],
      expect: {
        commandIdentity: "fx.spawn-return",
        causeCode: "DOMAIN_DEADLINE_UNCHANGED",
        effects: unchangedEffects,
        withinMillisecondsAfterDeadline: 500,
      },
    });
    const observed = await run(entry);
    receipt(entry, observed);
    try {
      expect(observed.ledger).toContain("handler-returned");
      assertEnvelope(entry, observed);
      assertDeadlineLag(entry, observed);
    } finally {
      await cleanup(observed);
    }
  },
  timeout,
);
