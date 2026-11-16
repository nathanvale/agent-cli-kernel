import type { CauseRow, CauseTable, RowGuidance } from "./types.ts";
import { causeRow, handoff, nextStep } from "./validation/result.ts";
import { carriesGlobalSwitch } from "./routing.ts";
import { integer, keys, record, text } from "./validation/primitives.ts";
import { internalResultCode } from "./state-causes.ts";
export type RetryDelayPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "bounded";
      readonly minimumMilliseconds: number;
      readonly maximumMilliseconds: number;
    };
export type StationWords = {
  readonly trigger: string;
  readonly repairAction: string | null;
  readonly retryDelayPolicy: RetryDelayPolicy;
  readonly reachability: "required" | "declared-unreachable";
  readonly unreachableRationale: string | null;
  readonly independentObservable: string;
};
export type StationInput<C extends CauseTable> = {
  [K in keyof C & string]: StationWords & {
    readonly commandIdentity: string;
    readonly causeCode: K;
    readonly guidance: RowGuidance<C[K]>;
  } & (C[K] extends { outcome: "success" }
      ? { readonly repairAction: null }
      : { readonly repairAction: string });
}[keyof C & string];
export type DeclaredStation = StationWords & {
  readonly commandIdentity: string;
  readonly causeCode: string;
  readonly row: CauseRow;
  readonly guidance:
    | { readonly next: import("./types.ts").NextStep; readonly handoff?: never }
    | { readonly handoff: import("./types.ts").Handoff; readonly next?: never };
};
// DISC-11b: the stations the fallback can select keep the base's fixed words.
export function reservedFallbackCause(causeCode: string): boolean {
  return internalResultCode(causeCode) || causeCode === "INTERNAL_PREPARATION";
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
// The exact key set station() builds. A raw declaration's station may carry
// no other (WIRE-1, DISC-8; K1-5), so admission checks against this list.
export const declaredStationKeys: readonly (keyof DeclaredStation)[] = [
  "commandIdentity",
  "causeCode",
  "row",
  "trigger",
  "guidance",
  "repairAction",
  "retryDelayPolicy",
  "reachability",
  "unreachableRationale",
  "independentObservable",
];
export function station<C extends CauseTable, const S extends StationInput<C>>(
  causes: C,
  spec: S,
): Omit<DeclaredStation, "row" | "guidance"> & {
  readonly causeCode: S["causeCode"];
  readonly commandIdentity: S["commandIdentity"];
  readonly row: C[S["causeCode"]];
  readonly guidance: S["guidance"];
} {
  const row = causes[spec.causeCode];
  if (!row || !causeRow(row)) throw new Error("Invalid cause row.");
  if (reservedFallbackCause(String(spec.causeCode)))
    throw new Error("Fallback station words are reserved.");
  validateWords(spec, row);
  return freeze({
    commandIdentity: spec.commandIdentity,
    causeCode: spec.causeCode,
    trigger: spec.trigger,
    guidance: structuredClone(spec.guidance),
    repairAction: spec.repairAction,
    retryDelayPolicy: structuredClone(spec.retryDelayPolicy),
    reachability: spec.reachability,
    unreachableRationale: spec.unreachableRationale,
    independentObservable: spec.independentObservable,
    row: structuredClone(row),
  });
}
export function validateWords(
  spec: StationWords & { readonly guidance: DeclaredStation["guidance"] },
  row: CauseRow,
): void {
  if (!text(spec.trigger) || !text(spec.independentObservable))
    throw new Error("Station needs trigger and independent observable.");
  if (
    spec.reachability !== "required" &&
    spec.reachability !== "declared-unreachable"
  )
    throw new Error("Unknown reachability.");
  if (
    spec.reachability === "required"
      ? spec.unreachableRationale !== null
      : !text(spec.unreachableRationale)
  )
    throw new Error("Unreachable needs a reviewed rationale.");
  if (
    row.outcome === "success"
      ? spec.repairAction !== null
      : !text(spec.repairAction)
  )
    throw new Error("Invalid repair action.");
  const guidance = spec.guidance;
  if (commandSteps(guidance).some((step) => carriesGlobalSwitch(step.args)))
    throw new Error("Command step args carry a global switch before --.");
  // DISC-8: guidance is strict `{ next }` or strict `{ handoff }` (K1-5).
  if (
    !record(guidance) ||
    !keys(guidance, [row.guidance]) ||
    (row.guidance === "handoff"
      ? !handoff(guidance.handoff)
      : !nextStep(guidance.next))
  )
    throw new Error("Wrong guidance arm.");
  if (guidance.next?.kind === "done" && row.outcome !== "success")
    throw new Error("Done requires success.");
  if ((guidance.next?.kind === "retry") !== row.retryable)
    throw new Error("Retry correlation.");
  validateDelay(spec.retryDelayPolicy, row.retryable);
}
// The command steps a declared guidance arm names, read defensively because
// a raw declaration reaches this check before its shape is proven.
function commandSteps(
  guidance: DeclaredStation["guidance"],
): readonly { readonly args: readonly unknown[] }[] {
  const inspect: unknown = guidance.handoff?.inspect;
  const steps: readonly unknown[] = guidance.next
    ? [guidance.next]
    : Array.isArray(inspect)
      ? inspect
      : [];
  return steps.flatMap((step) =>
    record(step) && step.kind === "command" && Array.isArray(step.args)
      ? [{ args: step.args }]
      : [],
  );
}
// DISC-8: the policy is strict; an extra key is never published (K1-5).
function validateDelay(policy: RetryDelayPolicy, retryable: boolean): void {
  if (!record(policy)) throw new Error("Invalid retry bounds.");
  if (!retryable) {
    if (policy.kind !== "none" || !keys(policy, ["kind"]))
      throw new Error("Unexpected delay policy.");
    return;
  }
  if (
    policy.kind !== "bounded" ||
    !keys(policy, ["kind", "minimumMilliseconds", "maximumMilliseconds"]) ||
    !integer(policy.minimumMilliseconds) ||
    policy.minimumMilliseconds < 1 ||
    !integer(policy.maximumMilliseconds) ||
    policy.maximumMilliseconds < policy.minimumMilliseconds
  )
    throw new Error("Invalid retry bounds.");
}
