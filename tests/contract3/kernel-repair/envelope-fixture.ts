import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { emptyInput as input, unchanged } from "./shapes.ts";

const step = { kind: "command", command: "specimen.help", args: [] } as const;
export const readStation = station(commonCauses, {
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
