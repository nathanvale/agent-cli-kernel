import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { tolerance } from "../lifecycle/oracle.ts";
import { emptyComplete, materialiseKf, oneEnvelope, runKf } from "./harness.ts";
import type { KfRun } from "./harness.ts";

// Accepted decision "Contract question 5 of 8" (K3-spec-4), its 16:23
// follow-up, and "Expectations points N2 and N3" (16:25, option A): when an
// owned program cannot be confirmed stopped the CLI claims no certainty on
// any exit path. LIFE-11, LIFE-6, WIRE-12, WIRE-13, WIRE-18, DISC-11b. The
// unconfirmed stop comes from a host programs add-on whose settle resolves
// false or throws (the shipped add-on has no deterministic trigger: a
// stated proof gap). Expected values come from expectations.md (KF3) and the
// N2 and N3 ruling.
let entry = "";
beforeAll(async () => {
  entry = await materialiseKf();
});
afterAll(async () => {
  await rm(join(dirname(entry), "../../../.."), {
    recursive: true,
    force: true,
  });
});

const pendingStep = { kind: "command", command: "kf.pending", args: [] };
// LIFE-6: the first stdout byte within the deadline plus the 500 ms wait,
// plus the harness tolerance (lifecycle oracle).
const deadlineBound = 300 + 500 + tolerance;

function deadlineRun(proof: string, settle: string) {
  return runKf(
    entry,
    "programs-apply",
    ["apply", "--deadline-ms", "300", "--json"],
    { KF_PROOF: proof, KF_SETTLE: settle, KF_WAIT: "2000" },
  );
}
function expectHandoff(run: KfRun) {
  expect(run.result).not.toHaveProperty("next");
  expect(run.result?.handoff).toMatchObject({ inspect: [pendingStep] });
}

// N3 option A: the proof's completed and remaining lists are kept, nothing
// moves to uncertain, and the inventory is incomplete.
const unconfirmed: Readonly<Record<string, unknown>> = {
  completed: {
    completed: ["kf.e"],
    remaining: [],
    uncertain: [],
    inventoryComplete: false,
  },
  partial: {
    completed: ["kf.e1"],
    remaining: ["kf.e2"],
    uncertain: [],
    inventoryComplete: false,
  },
  unchanged: {
    completed: [],
    remaining: ["kf.e"],
    uncertain: [],
    inventoryComplete: false,
  },
  // N9 (17:06): no transaction started and every later one refused.
  none: {
    completed: [],
    remaining: ["kf.e"],
    uncertain: [],
    inventoryComplete: false,
  },
  // A transaction started and issued no proof: nothing is known.
  stalled: { ...emptyComplete, inventoryComplete: false },
};
// The twins: every program confirmed stopped.
const confirmed: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  completed: {
    causeCode: "DOMAIN_DEADLINE_COMPLETED",
    transactionState: "completed",
    effects: { ...emptyComplete, completed: ["kf.e"] },
  },
  partial: {
    causeCode: "DOMAIN_DEADLINE_PARTIAL",
    transactionState: "partially-completed",
    effects: {
      ...emptyComplete,
      completed: ["kf.e1"],
      remaining: ["kf.e2"],
    },
  },
  unchanged: {
    causeCode: "DOMAIN_DEADLINE_UNCHANGED",
    transactionState: "unchanged",
    effects: { ...emptyComplete, remaining: ["kf.e"] },
  },
  // N9 (17:06): DOMAIN_DEADLINE_UNCHANGED with the declared effects.
  none: {
    causeCode: "DOMAIN_DEADLINE_UNCHANGED",
    transactionState: "unchanged",
    effects: { ...emptyComplete, remaining: ["kf.e"] },
  },
  stalled: {
    causeCode: "DOMAIN_DEADLINE_UNKNOWN",
    transactionState: "unknown",
    effects: { ...emptyComplete, inventoryComplete: false },
  },
};

describe("KF3.a changing-deadline-unconfirmed", () => {
  for (const proof of [
    "completed",
    "partial",
    "unchanged",
    "none",
    "stalled",
  ] as const)
    test(
      `KF3.a ${proof}`,
      async () => {
        for (const settle of ["false", "throw"]) {
          const run = await deadlineRun(proof, settle);
          expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
            exit: 3,
            one: true,
          });
          expect(run.result).toMatchObject({
            commandIdentity: "kf.apply",
            causeCode: "DOMAIN_DEADLINE_UNKNOWN",
            outcome: "failed",
            transactionState: "unknown",
            failureClass: "domain",
            retryable: false,
            effects: unconfirmed[proof],
          });
          expectHandoff(run);
          expect(run.ledger).toContain("program-started");
          expect(run.firstByte).toBeLessThanOrEqual(deadlineBound);
        }
        const twin = await deadlineRun(proof, "true");
        expect(twin.exit).toBe(3);
        expect(twin.result).toMatchObject(confirmed[proof] ?? {});
      },
      processWatchdog(3),
    );
});

describe("KF3.c changing-normal-unconfirmed", () => {
  test(
    "KF3.c a completed change whose owned program is not confirmed stopped is unknown with a handoff",
    async () => {
      for (const settle of ["false", "throw"]) {
        const run = await runKf(entry, "programs-apply", ["apply", "--json"], {
          KF_PROOF: "completed",
          KF_SETTLE: settle,
        });
        expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
          exit: 1,
          one: true,
        });
        // N2 option A: INTERNAL_RESULT_UNKNOWN, transaction state unknown.
        expect(run.result).toMatchObject({
          commandIdentity: "kf.apply",
          causeCode: "INTERNAL_RESULT_UNKNOWN",
          outcome: "failed",
          transactionState: "unknown",
          failureClass: "internal",
          effects: unconfirmed.completed,
        });
        expectHandoff(run);
        expect(run.ledger).toContain("handler-returned");
      }
      const twin = await runKf(entry, "programs-apply", ["apply", "--json"], {
        KF_PROOF: "completed",
        KF_SETTLE: "true",
      });
      expect(twin.exit).toBe(0);
      expect(twin.result).toMatchObject({
        causeCode: "SUCCESS_COMPLETED",
        next: { kind: "done" },
      });
    },
    processWatchdog(3),
  );
});

test(
  "KF3.c partial: a partial change whose owned program is not confirmed stopped is unknown with a handoff",
  async () => {
    const run = await runKf(entry, "programs-apply", ["apply", "--json"], {
      KF_PROOF: "partial",
      KF_SETTLE: "false",
    });
    expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
      exit: 1,
      one: true,
    });
    expect(run.result).toMatchObject({
      causeCode: "INTERNAL_RESULT_UNKNOWN",
      outcome: "failed",
      transactionState: "unknown",
      failureClass: "internal",
      retryable: false,
      data: null,
      effects: unconfirmed.partial,
    });
    expectHandoff(run);
    // Twin: settle true gives the declared partial station, inventory complete.
    const twin = await runKf(entry, "programs-apply", ["apply", "--json"], {
      KF_PROOF: "partial",
      KF_SETTLE: "true",
    });
    expect(twin.exit).toBe(3);
    expect(twin.result).toMatchObject({
      causeCode: "KF_PARTIAL",
      effects: { ...emptyComplete, completed: ["kf.e1"], remaining: ["kf.e2"] },
    });
  },
  processWatchdog(2),
);

describe("KF3.d inspect-normal-unconfirmed", () => {
  test(
    "KF3.d an inspect command whose owned program is not confirmed stopped fails unchanged",
    async () => {
      for (const settle of ["false", "throw"]) {
        const run = await runKf(entry, "watch", ["watch", "--json"], {
          KF_SETTLE: settle,
        });
        expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
          exit: 1,
          one: true,
        });
        expect(run.result).toMatchObject({
          commandIdentity: "kf.watch",
          causeCode: "INTERNAL_RESULT_UNCHANGED",
          outcome: "failed",
          transactionState: "unchanged",
          failureClass: "internal",
          effects: emptyComplete,
        });
        expect(run.result).toHaveProperty("handoff");
        expect(run.result).not.toHaveProperty("next");
        expect(run.ledger).toContain("program-started");
      }
      const twin = await runKf(entry, "watch", ["watch", "--json"], {
        KF_SETTLE: "true",
      });
      expect(twin.exit).toBe(0);
      expect(twin.result).toMatchObject({ causeCode: "SUCCESS_UNCHANGED" });
    },
    processWatchdog(3),
  );
});
