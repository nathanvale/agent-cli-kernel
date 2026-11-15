import type { CauseRow, CauseTable, RowGuidance } from "./types.ts";
import { causeRow, handoff, nextStep } from "./validation/result.ts";
import { integer, text } from "./validation/primitives.ts";
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
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
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
  if (
    String(spec.causeCode).startsWith("INTERNAL_RESULT_") ||
    spec.causeCode === "INTERNAL_PREPARATION"
  )
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
  if (
    row.guidance === "handoff"
      ? !handoff(guidance.handoff)
      : !nextStep(guidance.next)
  )
    throw new Error("Wrong guidance arm.");
  if (guidance.next?.kind === "done" && row.outcome !== "success")
    throw new Error("Done requires success.");
  if ((guidance.next?.kind === "retry") !== row.retryable)
    throw new Error("Retry correlation.");
  validateDelay(spec.retryDelayPolicy, row.retryable);
}
function validateDelay(policy: RetryDelayPolicy, retryable: boolean): void {
  if (!retryable) {
    if (policy.kind !== "none") throw new Error("Unexpected delay policy.");
    return;
  }
  if (
    policy.kind !== "bounded" ||
    !integer(policy.minimumMilliseconds) ||
    policy.minimumMilliseconds < 1 ||
    !integer(policy.maximumMilliseconds) ||
    policy.maximumMilliseconds < policy.minimumMilliseconds
  )
    throw new Error("Invalid retry bounds.");
}
