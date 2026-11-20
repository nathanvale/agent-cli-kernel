import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { emptyComplete, materialiseKf, oneEnvelope, runKf } from "./harness.ts";
import type { KfRun } from "./harness.ts";

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
const layers = ["seam", "addon"] as const;

async function proofRun(
  layer: (typeof layers)[number],
  proof: string,
  after: string,
): Promise<KfRun> {
  const root = await mkdtemp(join(dirname(entry), `state-${layer}-`));
  return runKf(entry, "proof", ["apply", "--json"], {
    KF_LAYER: layer,
    KF_STATE_ROOT: root,
    KF_PROOF: proof,
    KF_AFTER: after,
  });
}

const pendingStep = { kind: "command", command: "kf.pending", args: [] };
function expectFallback(
  run: KfRun,
  causeCode: string,
  transactionState: string,
  effects: unknown,
) {
  expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
    exit: 1,
    one: true,
  });
  expect(new TextEncoder().encode(run.stdout).byteLength).toBeLessThanOrEqual(
    16_384,
  );
  expect(run.envelope?.contractVersion).toBe("3.0.0");
  expect(run.result).toMatchObject({
    commandIdentity: "kf.apply",
    outcome: "failed",
    failureClass: "internal",
    retryable: false,
    data: null,
    causeCode,
    transactionState,
    effects,
  });
  expect(run.result).not.toHaveProperty("next");
  const handoff = run.result?.handoff;
  expect(handoff).toMatchObject({ inspect: [pendingStep] });
}
const applied = (run: KfRun, effect: string) =>
  run.ledger.filter((line) => line === `effect-applied ${effect}`).length;
async function expectNoProofTwin(layer: (typeof layers)[number]) {
  const twin = await proofRun(layer, "completed", "before");
  expectFallback(twin, "INTERNAL_RESULT_UNKNOWN", "unknown", {
    ...emptyComplete,
    inventoryComplete: false,
  });
  expect(applied(twin, "kf.e")).toBe(0);
}

describe("KF2 a handler fault after its transaction proof was issued", () => {
  for (const layer of layers) {
    test(
      `KF2.a throw-after-completed-proof ${layer}`,
      async () => {
        const run = await proofRun(layer, "completed", "throw");
        expectFallback(run, "INTERNAL_RESULT_COMPLETED", "completed", {
          ...emptyComplete,
          completed: ["kf.e"],
        });
        expect(applied(run, "kf.e")).toBe(1);
        await expectNoProofTwin(layer);
      },
      processWatchdog(2),
    );
    for (const variant of ["refusal", "invalid"] as const)
      test(
        `KF2.b returned-result-fails-after-proof ${variant} ${layer}`,
        async () => {
          const run = await proofRun(layer, "completed", variant);
          expectFallback(run, "INTERNAL_RESULT_COMPLETED", "completed", {
            ...emptyComplete,
            completed: ["kf.e"],
          });
          expect(applied(run, "kf.e")).toBe(1);
          const twin = await proofRun(layer, "unchanged", "refusal");
          expect({ exit: twin.exit, one: oneEnvelope(twin) }).toEqual({
            exit: 3,
            one: true,
          });
          expect(twin.result).toMatchObject({
            causeCode: "KF_HELD",
            outcome: "refused",
            transactionState: "unchanged",
          });
        },
        processWatchdog(2),
      );
    test(
      `KF2.c throw-after-partial-proof ${layer}`,
      async () => {
        const partial = {
          completed: ["kf.e1"],
          remaining: ["kf.e2"],
          uncertain: [],
          inventoryComplete: true,
        };
        const run = await proofRun(layer, "partial", "throw");
        expectFallback(
          run,
          "INTERNAL_RESULT_PARTIAL",
          "partially-completed",
          partial,
        );
        const twin = await proofRun(layer, "partial", "result");
        expect({ exit: twin.exit, one: oneEnvelope(twin) }).toEqual({
          exit: 3,
          one: true,
        });
        expect(twin.result).toMatchObject({
          causeCode: "KF_PARTIAL",
          effects: partial,
        });
      },
      processWatchdog(2),
    );
    test(
      `KF2.d throw-after-unchanged-proof ${layer}`,
      async () => {
        const run = await proofRun(layer, "unchanged", "throw");
        expectFallback(run, "INTERNAL_RESULT_UNCHANGED", "unchanged", {
          ...emptyComplete,
          remaining: ["kf.e"],
        });
        expect(applied(run, "kf.e")).toBe(0);
        expect(run.ledger).toContain("proof unchanged");
      },
      processWatchdog(1),
    );
    test(
      `KF2.e throw-after-unknown-proof ${layer}`,
      async () => {
        const run = await proofRun(layer, "unknown", "throw");
        expectFallback(run, "INTERNAL_RESULT_UNKNOWN", "unknown", {
          ...emptyComplete,
          uncertain: ["kf.e"],
        });
      },
      processWatchdog(1),
    );
    test(
      `KF2.f throw-after-oversize-proof ${layer}`,
      async () => {
        const run = await proofRun(layer, "wide40", "throw");
        expectFallback(run, "INTERNAL_RESULT_UNKNOWN", "unknown", {
          ...emptyComplete,
          inventoryComplete: false,
        });
        expect(run.ledger).toContain("proof completed");
        const twin = await proofRun(layer, "wide25", "throw");
        expectFallback(twin, "INTERNAL_RESULT_COMPLETED", "completed", {
          ...emptyComplete,
          completed: Array.from(
            { length: 25 },
            (_, index) =>
              `fx.wide.${String(index).padStart(2, "0")}.${"w".repeat(480)}`,
          ),
        });
      },
      processWatchdog(2),
    );
  }
});
