import type { Case } from "./harness.ts";

export const timerLimit = 2_147_483_647;

export const overLimitBoundary = [
  timerLimit,
  timerLimit + 1,
  timerLimit + 60_000,
  3_000_000_000,
  2 * timerLimit + 1,
] as const;

export const tolerance = 100;
export const killObservationTolerance = 30;

export const stopBound = 500;
export const cancellationWait = 500;
export const flushBound = 500;

export const unchangedEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

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
