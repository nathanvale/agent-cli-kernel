import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";

// One inspect command whose success station names a command step, so
// validation takes its asynchronous step-parsing path (R06, R07, R08).
const input = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const unchanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const step = { kind: "command", command: "specimen.help", args: [] } as const;
const readStation = station(commonCauses, {
  commandIdentity: "specimen.read",
  causeCode: "SUCCESS_UNCHANGED",
  trigger: "Read.",
  guidance: { next: step },
  repairAction: null,
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "repair-envelope",
});
export function envelopeContract() {
  const read = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input,
    capabilities: {},
    stations: [readStation],
    run: () => {
      throw new Error("Never entered.");
    },
  });
  return contractFor({ cli: "specimen", commands: [read] });
}
// A plain mutable envelope written from the WIRE-15 success row.
export function envelope(data: unknown) {
  return {
    contractVersion: "3.0.0",
    message: "Observed.",
    availablePaths: ["specimen.read"],
    result: {
      runId: "run-1",
      commandIdentity: "specimen.read",
      outcome: "success",
      effectClass: "inspect",
      transactionState: "unchanged",
      causeCode: "SUCCESS_UNCHANGED",
      failureClass: null,
      exitCode: 0,
      data,
      retryable: false,
      repairAction: null,
      effects: { ...unchanged },
      next: { ...step, args: [] },
    },
  };
}
