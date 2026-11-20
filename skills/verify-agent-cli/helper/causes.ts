import { commonCauses, station } from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";

export const cli = "verify-agent-cli";

export const unchangedSuccess =
  "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;
export const completedSuccess =
  "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses;

const refusedNext = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
} as const;

const refusedHandoff = { ...refusedNext, guidance: "handoff" } as const;

export const causes = {
  ...commonCauses,
  DOMAIN_VERIFY_RUN_EXISTS: refusedNext,
  DOMAIN_VERIFY_RUN_MISSING: refusedNext,
  DOMAIN_VERIFY_RUN_CLEAN: refusedNext,
  DOMAIN_VERIFY_TARGET_MISSING: refusedNext,
  DOMAIN_VERIFY_STEP_EXISTS: refusedNext,
  DOMAIN_VERIFY_ARGV_INVALID: refusedNext,
  DOMAIN_VERIFY_DOCTOR_FAILED: refusedNext,
  DOMAIN_VERIFY_SWEEP_FAILED: refusedNext,
  DOMAIN_VERIFY_RUN_HELD: refusedHandoff,
  DOMAIN_VERIFY_RUN_UNRESOLVED: refusedHandoff,
  DOMAIN_VERIFY_STATE_UNAVAILABLE: refusedHandoff,
  DOMAIN_VERIFY_CHANGE_UNCHANGED: {
    outcome: "failed",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_VERIFY_CHANGE_UNKNOWN: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_VERIFY_EXPECTATION_UNMET: {
    outcome: "failed",
    transactionState: "completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;

export const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

export const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

export const nothingChanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

export const nameRule = {
  kind: "string",
  minLength: 1,
  maxLength: 63,
  choices: null,
  pattern: "[a-z0-9][a-z0-9-]*",
} as const;

export const runArgument = {
  name: "run",
  summary: "The run's name: lower-case letters, digits and hyphens.",
  required: true,
  value: nameRule,
} as const;

const inspectState = {
  owner: "operator",
  reason: "The helper's state needs a look before another change to this run.",
  inspect: [{ kind: "command", command: "verify-agent-cli.pending", args: [] }],
} as const;

export function stateStations<const Identity extends string>(
  identity: Identity,
) {
  return [
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_VERIFY_RUN_HELD",
      trigger: "Another helper process is changing this run now.",
      repairAction: "Wait for that helper process to finish, then try again.",
      guidance: { handoff: inspectState },
      independentObservable: `${identity}:run-held`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_VERIFY_RUN_UNRESOLVED",
      trigger: "An earlier change to this run never finished.",
      repairAction:
        "Read the pending command's report, then launch a new run under another name.",
      guidance: { handoff: inspectState },
      independentObservable: `${identity}:run-unresolved`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      trigger: "The helper's state folder cannot take this change.",
      repairAction:
        "Read the message for the reason, and repair the state folder it names.",
      guidance: { handoff: inspectState },
      independentObservable: `${identity}:state-unavailable`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_VERIFY_CHANGE_UNCHANGED",
      trigger: "The change failed before it touched anything.",
      repairAction:
        "Read the message for the failure, repair it, and run again.",
      guidance: { handoff: inspectState },
      independentObservable: `${identity}:change-unchanged`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_VERIFY_CHANGE_UNKNOWN",
      trigger: "The change started, and the helper could not confirm it.",
      repairAction:
        "Read the pending command's report and the run's folder before anything else.",
      guidance: { handoff: inspectState },
      independentObservable: `${identity}:change-unknown`,
    }),
  ] as const;
}
