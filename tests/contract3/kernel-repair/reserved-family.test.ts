import { expect, test } from "bun:test";
import { contractFor } from "../../../starters/contract3/src/kernel/index.ts";
import { reservedFallbackCause } from "../../../starters/contract3/src/kernel/stations.ts";
import { contractUnchecked } from "./harness.ts";
import { emptyInput } from "./shapes.ts";

// F-1: DISC-11b reserves every INTERNAL_RESULT_* cause, not only the four the
// base selects. Not a frozen case identity: a control beside R03, which lists
// only the named causes.
const row = {
  outcome: "failed",
  transactionState: "unchanged",
  failureClass: "internal",
  exitCode: 1,
  retryable: false,
  guidance: "handoff",
} as const;
function declaration(causeCode: string) {
  return {
    commandIdentity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input: emptyInput,
    capabilities: {},
    effectClass: "inspect",
    // A raw declaration needs a handler to be admitted (K1-5); never run.
    execute: () =>
      Promise.resolve({
        ok: false,
        path: "handler",
        reason: "Raw admission fixture never runs.",
      } as const),
    stations: [
      {
        commandIdentity: "specimen.read",
        causeCode,
        row,
        trigger: "Host words.",
        repairAction: "Host repair.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "Host reason.",
            inspect: [{ kind: "instruction", text: "Host inspection." }],
          },
        },
        retryDelayPolicy: { kind: "none" },
        reachability: "required",
        unreachableRationale: null,
        independentObservable: "reserved-family",
      },
    ],
  };
}
function admission(causeCode: string): string {
  try {
    contractUnchecked(contractFor, {
      cli: "specimen",
      commands: [declaration(causeCode)],
      causes: { [causeCode]: row },
    });
    return "admitted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("an unnamed INTERNAL_RESULT_* host station is refused as reserved", () => {
  expect(reservedFallbackCause("INTERNAL_RESULT_CUSTOM")).toBe(true);
  expect(admission("INTERNAL_RESULT_CUSTOM")).toMatch(/reserved/i);
  // Twin: the same row under a host cause name is admitted, so the refusal is
  // the reserved-family rule and nothing else.
  expect(reservedFallbackCause("HOST_INTERNAL_RESULT")).toBe(false);
  expect(admission("HOST_INTERNAL_RESULT")).toBe("admitted");
});
