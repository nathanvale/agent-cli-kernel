import type { Refusal, stateAddon } from "agent-cli-kernel/addons/state";

export type State = ReturnType<typeof stateAddon>;

export type StateCause =
  | "DOMAIN_VERIFY_RUN_HELD"
  | "DOMAIN_VERIFY_RUN_UNRESOLVED"
  | "DOMAIN_VERIFY_STATE_UNAVAILABLE";

export type Refused = {
  readonly causeCode: StateCause;
  readonly message: string;
};

export function refusalOf(
  outcome: Refusal | { readonly kind: "ran" },
  run: string,
): Refused | undefined {
  switch (outcome.kind) {
    case "ran":
      return undefined;
    case "held-lock":
      return {
        causeCode: "DOMAIN_VERIFY_RUN_HELD",
        message: `Run ${run} is being changed by operation ${outcome.operationId}.`,
      };
    case "unresolved-case":
      return {
        causeCode: "DOMAIN_VERIFY_RUN_UNRESOLVED",
        message: `Run ${run} has an unfinished change, operation ${outcome.operationId}.`,
      };
    case "unavailable":
      return {
        causeCode: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
        message: `The helper's state is unavailable: ${outcome.reason}${outcome.detail === undefined ? "" : ` (${outcome.detail})`}.`,
      };
    case "busy":
    case "denied":
    case "approval-lost":
    case "approval-unavailable":
      return {
        causeCode: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
        message: `The helper's state refused the change: ${outcome.kind}.`,
      };
  }
}

export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Unfinished = {
  readonly causeCode:
    | "DOMAIN_VERIFY_CHANGE_UNCHANGED"
    | "DOMAIN_VERIFY_CHANGE_UNKNOWN";
  readonly message: string;
};

export function unfinishedChange(
  transactionState: string,
  beforeAnything: string,
  unconfirmed: string,
): Unfinished {
  return transactionState === "unchanged"
    ? { causeCode: "DOMAIN_VERIFY_CHANGE_UNCHANGED", message: beforeAnything }
    : { causeCode: "DOMAIN_VERIFY_CHANGE_UNKNOWN", message: unconfirmed };
}
