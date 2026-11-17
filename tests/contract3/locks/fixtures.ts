import {
  command,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { commonCauses } from "../../../starters/contract3/src/kernel/index.ts";
import type {
  ResultFor,
  CauseTable,
  Handoff,
} from "../../../starters/contract3/src/kernel/index.ts";
export { commonCauses };
export { exits } from "../../../starters/contract3/src/kernel/index.ts";
export {
  command,
  changing,
  station,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
export type * from "../../../starters/contract3/src/kernel/index.ts";
export type Result = ResultFor<typeof commonCauses>;
export const handoff = {
  owner: "operator",
  reason: "Inspect the resource.",
  inspect: [{ kind: "instruction", text: "Inspect the resource." }],
} as const satisfies Handoff;
const facts = {
  runId: "run-1",
  commandIdentity: "specimen.inspect",
  data: null,
  repairAction: "Inspect.",
  effectClass: "repository-local",
} as const;
const unchanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
export const success = {
  ...facts,
  outcome: "success",
  transactionState: "unchanged",
  causeCode: "SUCCESS_UNCHANGED",
  failureClass: null,
  exitCode: 0,
  retryable: false,
  repairAction: null,
  effects: unchanged,
  next: { kind: "done" },
} as const satisfies Result;
export const refusal = {
  ...facts,
  outcome: "refused",
  transactionState: "unchanged",
  causeCode: "DOMAIN_PRECONDITION_UNMET",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  effects: unchanged,
  next: { kind: "instruction", text: "Inspect." },
} as const satisfies Result;
export const unknown = {
  ...facts,
  outcome: "failed",
  transactionState: "unknown",
  causeCode: "INTERNAL_RESULT_UNKNOWN",
  failureClass: "internal",
  exitCode: 1,
  retryable: false,
  effects: {
    completed: [],
    remaining: [],
    uncertain: ["write"],
    inventoryComplete: true,
  },
  handoff,
} as const satisfies Result;
export const partial = {
  ...facts,
  outcome: "failed",
  transactionState: "partially-completed",
  causeCode: "INTERNAL_RESULT_PARTIAL",
  failureClass: "internal",
  exitCode: 1,
  retryable: false,
  effects: {
    completed: ["write"],
    remaining: ["verify"],
    uncertain: [],
    inventoryComplete: true,
  },
  handoff,
} as const satisfies Result;
export const retry = {
  ...facts,
  outcome: "refused",
  transactionState: "unchanged",
  causeCode: "TRANSIENT_NOT_STARTED",
  failureClass: "transient",
  exitCode: 75,
  retryable: true,
  retryDelayMilliseconds: 10,
  effects: unchanged,
  next: { kind: "retry" },
} as const satisfies Result;
// Test-owned exemplar causes. These are not new common causes or T8 integration proof.
export const exemplarCauses = {
  JOURNAL_LIMIT: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  PRIOR_RUN: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  PARTIAL_RECOVERY: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;
export type ExemplarResult = ResultFor<typeof exemplarCauses>;
export const journal = {
  ...refusal,
  causeCode: "JOURNAL_LIMIT",
} as const satisfies ExemplarResult;
export const prior = {
  ...facts,
  ...exemplarCauses.PRIOR_RUN,
  causeCode: "PRIOR_RUN",
  handoff,
  effects: unchanged,
} as const satisfies ExemplarResult;
export const recovered = {
  ...partial,
  causeCode: "PARTIAL_RECOVERY",
  failureClass: "domain",
  exitCode: 3,
} as const satisfies ExemplarResult;
export const input = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
export const words = {
  trigger: "The resource is absent.",
  repairAction: "Inspect.",
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "Resource is absent.",
} as const;

export const inspectStation = station(commonCauses, {
  ...words,
  commandIdentity: "specimen.inspect",
  causeCode: "DOMAIN_PRECONDITION_UNMET",
  guidance: { next: { kind: "instruction", text: "Inspect." } },
});
export const inspect = command({
  identity: "specimen.inspect",
  route: ["inspect"],
  summary: "Inspect.",
  input,
  capabilities: {},
  stations: [inspectStation],
  run: (_input, context) => context.result(inspectStation, runFacts),
});
export function inspectFor<const Target extends string>(target: Target) {
  const selected = station(commonCauses, {
    ...words,
    commandIdentity: "specimen.inspect",
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    guidance: { next: { kind: "command", command: target, args: [] } },
  });
  return command({
    identity: "specimen.inspect",
    route: ["inspect"],
    summary: "Inspect.",
    input,
    capabilities: {},
    stations: [selected],
    run: (_input, context) => context.result(selected, runFacts),
  });
}
export function reportFor<const Target extends string>(target: Target) {
  const selected = station(exemplarCauses, {
    ...words,
    commandIdentity: "specimen.report",
    causeCode: "PRIOR_RUN",
    guidance: {
      handoff: {
        ...handoff,
        inspect: [{ kind: "command", command: target, args: [] }],
      },
    },
  });
  return command({
    identity: "specimen.report",
    route: ["report"],
    summary: "Report.",
    input,
    capabilities: {},
    stations: [selected],
    run: (_input, context) => context.result(selected, runFacts),
  });
}
export const runFacts = {
  runId: "run-1",
  message: "Inspect.",
  data: null,
  effects: unchanged,
} as const;

export const defaultSelection = {
  commandIdentity: "specimen.inspect",
  causeCode: "SUCCESS_UNCHANGED",
} as const;
export const otherStation = station(commonCauses, {
  ...words,
  commandIdentity: "specimen.other",
  causeCode: "DOMAIN_PRECONDITION_UNMET",
  guidance: { next: { kind: "instruction", text: "Inspect." } },
});
export const otherSuccessStation = station(commonCauses, {
  ...words,
  commandIdentity: "specimen.other",
  causeCode: "SUCCESS_UNCHANGED",
  repairAction: null,
  guidance: { next: { kind: "done" } },
});
export const other = command({
  identity: "specimen.other",
  route: ["other"],
  summary: "Other.",
  input,
  capabilities: {},
  stations: [otherStation, otherSuccessStation],
  run: (_input, context) => context.result(otherStation, runFacts),
});
