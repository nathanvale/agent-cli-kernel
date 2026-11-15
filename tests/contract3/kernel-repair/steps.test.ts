import { expect } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { validateEnvelope } from "../../../starters/contract3/src/kernel/validation/envelope.ts";
import { buildUnchecked, runFamily } from "./harness.ts";
import { emptyInput as empty, unchanged } from "./shapes.ts";

// R05 (F05). After the F01 admission check, a declaration carrying the
// empty-args root step is refused before any envelope exists. Each case
// records which layer refused, and the envelope validator is also exercised
// directly on the declared stations so the F05 rule keeps its own proof.
const withFlag = {
  ...empty,
  options: [
    {
      name: "--all",
      aliases: [],
      summary: "All.",
      required: false,
      repeatable: false,
      value: null,
    },
  ],
} as const;
const hold = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;
const causes = { ...commonCauses, HOLD: hold };
const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "repair-steps",
} as const;

function declarations(args: readonly string[]) {
  const step = { kind: "command", command: "specimen.root", args } as const;
  const root = command({
    identity: "specimen.root",
    route: [],
    summary: "Root.",
    input: withFlag,
    capabilities: {},
    run: () => {
      throw new Error("Never entered.");
    },
  });
  const read = command({
    identity: "specimen.read",
    route: ["read"],
    summary: "Read.",
    input: empty,
    capabilities: {},
    stations: [
      station(causes, {
        commandIdentity: "specimen.read",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        guidance: { next: step },
        repairAction: null,
        ...words,
      }),
      station(causes, {
        commandIdentity: "specimen.read",
        causeCode: "HOLD",
        trigger: "Held.",
        guidance: {
          handoff: { owner: "operator", reason: "Inspect.", inspect: [step] },
        },
        repairAction: "Inspect the root.",
        ...words,
      }),
    ],
    run: () => {
      throw new Error("Never entered.");
    },
  });
  return { root, read };
}
function fixture(args: readonly string[]) {
  const { root, read } = declarations(args);
  return contractFor({
    cli: "specimen",
    commands: [root, read],
    causes: { HOLD: hold },
  });
}
// Records which layer refused: admission (after F01) or the built contract.
function attempt(args: readonly string[]) {
  try {
    return { contract: fixture(args), refusal: "" };
  } catch (error) {
    return {
      contract: undefined,
      refusal: error instanceof Error ? error.message : String(error),
    };
  }
}
function admissionNamesRootStep(refusal: string) {
  expect(refusal).toContain("specimen.root");
  expect(refusal).toContain("root operation");
}
// The F05 rule itself, independent of admission: the envelope validator over
// the declared stations, without contractFor.
function validatedDirectly(arm: "next" | "handoff", args: readonly string[]) {
  const { root, read } = declarations(args);
  return validateEnvelope(
    envelope(arm, args),
    causes,
    [root, read],
    new Map([["specimen.read", read.stations]]),
  );
}
// Envelope fields written from the WIRE-15 rows, not from kernel output.
function envelope(arm: "next" | "handoff", args: readonly string[]) {
  const step = { kind: "command", command: "specimen.root", args };
  const base = {
    runId: "run-1",
    commandIdentity: "specimen.read",
    effectClass: "inspect",
    transactionState: "unchanged",
    data: null,
    retryable: false,
    effects: unchanged,
  };
  return {
    contractVersion: "3.0.0",
    message: "Observed.",
    availablePaths: ["specimen.read"],
    result:
      arm === "next"
        ? {
            ...base,
            outcome: "success",
            causeCode: "SUCCESS_UNCHANGED",
            failureClass: null,
            exitCode: 0,
            repairAction: null,
            next: step,
          }
        : {
            ...base,
            outcome: "refused",
            causeCode: "HOLD",
            failureClass: "domain",
            exitCode: 3,
            repairAction: "Inspect the root.",
            handoff: { owner: "operator", reason: "Inspect.", inspect: [step] },
          },
  };
}
async function refusedEnvelope(arm: "next" | "handoff") {
  expect(await validatedDirectly(arm, ["--all"])).toMatchObject({ ok: true });
  expect(await validatedDirectly(arm, [])).toEqual({
    ok: false,
    path: "result",
    reason: "invalid command step",
  });
  const admitted = attempt([]);
  if (admitted.contract)
    expect(await admitted.contract.validate(envelope(arm, []))).toMatchObject({
      ok: false,
    });
  else admissionNamesRootStep(admitted.refusal);
}

runFamily("R05", {
  "R05.next-empty-root-refused": () => refusedEnvelope("next"),
  "R05.handoff-empty-root-refused": () => refusedEnvelope("handoff"),
  "R05.build-empty-root-refused": async () => {
    const admitted = attempt([]);
    if (!admitted.contract) {
      admissionNamesRootStep(admitted.refusal);
      return;
    }
    const contract = admitted.contract;
    for (const [causeCode, facts] of [
      ["SUCCESS_UNCHANGED", { data: null }],
      ["HOLD", { data: null }],
    ] as const)
      expect(
        await buildUnchecked(
          contract,
          { commandIdentity: "specimen.read", causeCode },
          { ...facts, runId: "run-1", message: "Built.", effects: unchanged },
        ),
      ).toMatchObject({ ok: false });
  },
  "R05.flag-twin-agrees": async () => {
    const contract = fixture(["--all"]);
    for (const arm of ["next", "handoff"] as const)
      expect(await contract.validate(envelope(arm, ["--all"]))).toMatchObject({
        ok: true,
      });
    expect(await contract.parse("specimen.root", ["--all"])).toMatchObject({
      ok: true,
    });
    expect(await contract.resolve(["--all"])).toMatchObject({
      ok: true,
      value: { commandIdentity: "specimen.root" },
    });
  },
});
