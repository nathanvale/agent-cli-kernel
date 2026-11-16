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
};

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
