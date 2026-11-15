import type { Effects, TransactionState } from "./types.ts";

// One owner for the effect inventories and the state-keyed causes the base
// selects itself (LIFE-6, LIFE-9, WIRE-12, WIRE-18).
export const unchangedEffects: Effects = Object.freeze({
  completed: Object.freeze([]),
  remaining: Object.freeze([]),
  uncertain: Object.freeze([]),
  inventoryComplete: true,
});
// An unknown state whose inventory itself is unconfirmed.
export const incompleteEffects: Effects = Object.freeze({
  completed: Object.freeze([]),
  remaining: Object.freeze([]),
  uncertain: Object.freeze([]),
  inventoryComplete: false,
});

export const internalResultCause = {
  unchanged: "INTERNAL_RESULT_UNCHANGED",
  completed: "INTERNAL_RESULT_COMPLETED",
  "partially-completed": "INTERNAL_RESULT_PARTIAL",
  unknown: "INTERNAL_RESULT_UNKNOWN",
} as const satisfies Record<TransactionState, string>;

export const deadlineCause = {
  unchanged: "DOMAIN_DEADLINE_UNCHANGED",
  completed: "DOMAIN_DEADLINE_COMPLETED",
  "partially-completed": "DOMAIN_DEADLINE_PARTIAL",
  unknown: "DOMAIN_DEADLINE_UNKNOWN",
} as const satisfies Record<TransactionState, string>;
