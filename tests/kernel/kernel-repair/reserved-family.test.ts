import { expect, test } from "bun:test";
import { contractFor } from "../../../kernel/src/kernel/index.ts";
import { reservedFallbackCause } from "../../../kernel/src/kernel/stations.ts";
import { contractUnchecked } from "./harness.ts";
import { emptyInput } from "./shapes.ts";
import { neverRuns } from "./handlers.ts";

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
    execute: neverRuns,
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
  expect(reservedFallbackCause("INTERNAL_HOST_RESULT")).toBe(false);
  expect(admission("INTERNAL_HOST_RESULT")).toBe("admitted");
});
