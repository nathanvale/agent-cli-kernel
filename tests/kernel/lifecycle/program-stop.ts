import { station } from "../../../kernel/src/kernel/index.ts";
import type { CauseTable } from "../../../kernel/src/kernel/index.ts";

export const programStopRow = {
  outcome: "failed",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;

export function programStopStation<const Identity extends string>(
  causes: CauseTable,
  commandIdentity: Identity,
  causeCode: string,
) {
  return station(causes, {
    commandIdentity,
    causeCode,
    trigger:
      "The deadline passed and a program this command started was not confirmed stopped.",
    guidance: {
      handoff: {
        owner: "operator",
        reason: "A program this command started may still be running.",
        inspect: [
          {
            kind: "instruction",
            text: "Look in the process table for a program this command started that is still running.",
          },
        ],
      },
    },
    repairAction:
      "Confirm that the program this command started has stopped before a new run.",
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: `${commandIdentity}:program-stop-unconfirmed`,
  });
}
