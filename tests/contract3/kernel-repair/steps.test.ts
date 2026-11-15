import { expect } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { buildUnchecked, runFamily } from "./harness.ts";

// R05 (F05). After the F01 admission check, a declaration carrying the
// empty-args root step is refused before any envelope exists; refusal at
// admission therefore satisfies "refused" as well as refusal by validate.
const empty = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
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
const unchanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
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

function fixture(args: readonly string[]) {
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
  return contractFor({
    cli: "specimen",
    commands: [root, read],
    causes: { HOLD: hold },
  });
}
function admitted(args: readonly string[]) {
  try {
    return fixture(args);
  } catch {
    return undefined;
  }
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
  const contract = admitted([]);
  if (!contract) return;
  expect(await contract.validate(envelope(arm, []))).toMatchObject({
    ok: false,
  });
}

runFamily("R05", {
  "R05.next-empty-root-refused": () => refusedEnvelope("next"),
  "R05.handoff-empty-root-refused": () => refusedEnvelope("handoff"),
  "R05.build-empty-root-refused": async () => {
    const contract = admitted([]);
    if (!contract) return;
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
