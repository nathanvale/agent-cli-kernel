import type { StateAddonDescriptor } from "../../../kernel/src/kernel/state-seam.ts";
import { createStateAddon } from "../../../kernel/src/kernel/state-seam.ts";

export const emptyInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
export const unchanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
export const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;
export const repairWords = {
  discovery: "Correct the invocation using this command's discovery.",
  inspect:
    "Inspect the command, its input and independently observable resource before a new run.",
} as const;
export const refusedHandoff = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;

export function inertState(cli: string): StateAddonDescriptor {
  return createStateAddon((issuer) => ({
    ifNoResult: issuer.ifNoResult({
      kind: "command",
      command: `${cli}.pending`,
      args: [],
    }),
    attach() {
      throw new Error("This case never attaches state.");
    },
  }));
}
