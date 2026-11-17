import { knownProof, knownCapability } from "../state-seam.ts";
import type { TransactionProof, StateAddonDescriptor } from "../state-seam.ts";
import { effects } from "./result.ts";
import { record, text } from "./primitives.ts";
// This validates structure only. The issuer's private WeakSet proves identity.
export function proofValue(
  value: unknown,
  runId: string,
  descriptor: StateAddonDescriptor | undefined,
): value is TransactionProof {
  if (
    !record(value) ||
    !text(value.runId) ||
    !effects(value.effects) ||
    !knownProof(value, runId, descriptor)
  )
    return false;
  return (
    value.transactionState === "unchanged" ||
    value.transactionState === "completed" ||
    value.transactionState === "partially-completed" ||
    value.transactionState === "unknown"
  );
}

export function stateContext<Effect extends string>(
  value: unknown,
  effects: readonly Effect[],
): value is {
  readonly state: import("../capabilities.ts").StateCapability<Effect>;
} {
  return (
    record(value) &&
    record(value.state) &&
    typeof value.state.transaction === "function" &&
    knownCapability(value.state, effects)
  );
}
