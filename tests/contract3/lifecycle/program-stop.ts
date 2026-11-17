import { station } from "../../../starters/contract3/src/kernel/index.ts";
import type { CauseTable } from "../../../starters/contract3/src/kernel/index.ts";

// One owner for the lifecycle fixtures' program-stop station. Accepted
// decisions of 17:06 (form H, the name, the declaration rule N1b) and 17:24
// (the words, N1d): an inspect command that runs programs and supports a
// deadline declares DOMAIN_<CLI>_DEADLINE_PROGRAM_STOP_UNCONFIRMED in its own
// cause and station tables. The trigger is the expectations author's
// recommended wording (N1f, open).
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
