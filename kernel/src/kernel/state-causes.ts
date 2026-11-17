import type { Effects, TransactionState } from "./types.ts";

export const unchangedEffects: Effects = Object.freeze({
  completed: Object.freeze([]),
  remaining: Object.freeze([]),
  uncertain: Object.freeze([]),
  inventoryComplete: true,
});
export const incompleteEffects: Effects = Object.freeze({
  completed: Object.freeze([]),
  remaining: Object.freeze([]),
  uncertain: Object.freeze([]),
  inventoryComplete: false,
});

const internalResultPrefix = "INTERNAL_RESULT_";
export function internalResultCode(causeCode: string): boolean {
  return causeCode.startsWith(internalResultPrefix);
}
export const internalResultCause = {
  unchanged: "INTERNAL_RESULT_UNCHANGED",
  completed: "INTERNAL_RESULT_COMPLETED",
  "partially-completed": "INTERNAL_RESULT_PARTIAL",
  unknown: "INTERNAL_RESULT_UNKNOWN",
} as const satisfies Record<
  TransactionState,
  `${typeof internalResultPrefix}${string}`
>;

export const deadlineCause = {
  unchanged: "DOMAIN_DEADLINE_UNCHANGED",
  completed: "DOMAIN_DEADLINE_COMPLETED",
  "partially-completed": "DOMAIN_DEADLINE_PARTIAL",
  unknown: "DOMAIN_DEADLINE_UNKNOWN",
} as const satisfies Record<TransactionState, string>;
