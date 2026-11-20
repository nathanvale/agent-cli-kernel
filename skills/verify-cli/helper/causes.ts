import { commonCauses, station } from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";
export { cli } from "./place.ts";

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
  DOMAIN_VERIFY_TARGET_START: refusedNext,
  DOMAIN_VERIFY_TARGET_MISSING: refusedNext,
  DOMAIN_VERIFY_FINDINGS: refusedNext,
  DOMAIN_VERIFY_RUN_EXISTS: refusedNext,
  DOMAIN_VERIFY_RUN_IN_WORK_TREE: refusedNext,
  DOMAIN_VERIFY_NO_PIN: refusedNext,
  DOMAIN_VERIFY_GIT_FAILED: refusedNext,
  DOMAIN_VERIFY_RUN_MISSING: refusedNext,
  DOMAIN_VERIFY_RUN_CLEAN: refusedNext,
  DOMAIN_VERIFY_SCENARIO: refusedNext,
  DOMAIN_VERIFY_ALREADY_DRIVEN: refusedNext,
  DOMAIN_VERIFY_EVIDENCE_UNREADABLE: refusedHandoff,
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

const absolutePath = {
  kind: "string",
  minLength: 2,
  maxLength: 4096,
  choices: null,
  pattern: "/.*",
} as const;

export const runArgument = {
  name: "run",
  summary:
    "The verification run's folder, as an absolute path. Launch wants it new or empty, outside every git work tree.",
  required: true,
  value: absolutePath,
} as const;

export const targetArgument = {
  name: "target",
  summary: "The target's entry file, as an absolute path.",
  required: true,
  value: absolutePath,
} as const;

export const scenarioArgument = {
  name: "scenario",
  summary: "The scenario file, as an absolute path.",
  required: true,
  value: absolutePath,
} as const;

const inspectState = {
  owner: "operator",
  reason: "The helper's state needs a look before another change to this run.",
  inspect: [
    {
      kind: "instruction",
      text: "Run the pending command with this run's folder, and read the run's folder.",
    },
  ],
} as const;

export function missingRunStation<const Identity extends string>(
  identity: Identity,
) {
  return station(causes, {
    ...stationWords,
    commandIdentity: identity,
    causeCode: "DOMAIN_VERIFY_RUN_MISSING",
    trigger: "The folder holds no run that launch made.",
    repairAction:
      "Run launch with a new folder and the target, then try again.",
    guidance: {
      next: {
        kind: "instruction",
        text: "Run launch with a new folder and the target's entry file.",
      },
    },
    independentObservable: `${identity}:run-missing`,
  });
}

export function unreadableStation<const Identity extends string>(
  identity: Identity,
) {
  return station(causes, {
    ...stationWords,
    commandIdentity: identity,
    causeCode: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
    trigger: "The run's index or a step's evidence file cannot be read.",
    repairAction:
      "Keep the run's folder as it is for review, and launch a new run in another folder.",
    guidance: {
      handoff: {
        owner: "operator",
        reason:
          "The run's evidence folder holds a file the helper cannot read.",
        inspect: [
          {
            kind: "instruction",
            text: "Open the file the message names, in the run's evidence folder.",
          },
        ],
      },
    },
    independentObservable: `${identity}:evidence-unreadable`,
  });
}

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
        "Read the pending command's report for this run, keep its folder as evidence, and launch a new run in another folder.",
      guidance: { handoff: inspectState },
      independentObservable: `${identity}:run-unresolved`,
    }),
    station(causes, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
      trigger: "The run's state folder cannot take this change.",
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
