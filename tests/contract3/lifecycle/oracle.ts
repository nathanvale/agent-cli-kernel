// Test-owned oracle values and builders for the T2 supporting cases. They
// restate the frozen contract independently of production code, once.
import type { Case } from "./harness.ts";

// The largest delay a runtime timer holds (finding 1, Nathan's decision of
// 16 November 2026): restated here, never imported from production.
export const timerLimit = 2_147_483_647;

// Standards review F3: one boundary table drives both long-timer copies (the
// kernel's through T02(b), the programs add-on's through T05). LIMIT + 1 is
// one full step and a 1 ms remainder; 2 x LIMIT + 1 is two full steps.
export const overLimitBoundary = [
  timerLimit,
  timerLimit + 1,
  timerLimit + 60_000,
  3_000_000_000,
  2 * timerLimit + 1,
] as const;

// Harness observation tolerance added to every contract bound. Calibrated
// from receipts: process exit observation adds about 2 to 20 ms on this host
// (L01 exits 10 to 20 ms after the signal; spawn to front-door start 20 to
// 40 ms is excluded by the ledgered front-door clock). 100 ms keeps a
// first-signal exit at 650 ms or a 1,000 ms deadline wait RED.
export const tolerance = 100;
// Polling and kill latency when the process table is watched for an owned
// child's death (baseline death about 305 ms, P08).
export const killObservationTolerance = 30;

// LIFE-3 and the lifecycle table: a first stop request exits within 500 ms.
export const stopBound = 500;
// DIAG-9 and DIAG-14: the diagnostics flush takes at most 500 ms.
export const flushBound = 500;

// WIRE-13: an inspect command's effects (unchanged, complete inventory).
export const unchangedEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

// A supporting case with its own identity (not in the frozen case file).
export function supporting(
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
