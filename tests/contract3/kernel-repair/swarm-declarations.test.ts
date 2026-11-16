import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { neverRuns } from "./handlers.ts";
import { contractUnchecked } from "./harness.ts";
import { emptyInput, unchanged } from "./shapes.ts";

// Swarm-triage expectations for declarations reaching contractFor. Expected
// values come from the triage file's X-K1-* expectations (frozen contract),
// never from kernel output.

// A typed, admitted base that each raw variant departs from in one way.
function base() {
  return command({
    identity: "x.raw",
    route: ["raw"],
    summary: "Raw.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) =>
      context.result(
        { commandIdentity: "x.raw", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Raw.", data: null, effects: unchanged },
      ),
  });
}
const unmet = station(commonCauses, {
  commandIdentity: "x.raw",
  causeCode: "DOMAIN_PRECONDITION_UNMET",
  trigger: "Unmet.",
  repairAction: "Repair.",
  guidance: { next: { kind: "instruction", text: "Repair it." } },
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "swarm-declarations",
});
function refusalOf(run: () => unknown): string {
  try {
    run();
    return "admitted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
function admit(raw: object) {
  return () => contractUnchecked(contractFor, { cli: "x", commands: [raw] });
}

test("X-K1-5.raw-declaration-admission: contractFor re-checks every constructor rule on a raw declaration", () => {
  // Each variant and the refusal that names its broken rule (WIRE-15
  // preparation, DISC-8 station shape, WIRE-1 strict objects, DISC-13).
  const variants: readonly (readonly [string, object, string])[] = [
    [
      "no execute",
      {
        commandIdentity: "x.raw",
        route: ["raw"],
        summary: "Raw.",
        effectClass: "inspect",
        input: emptyInput,
        stations: [],
        capabilities: {},
      },
      "Host command needs an executable handler.",
    ],
    [
      "blank summary",
      { ...base(), summary: "  " },
      "Invalid command declaration.",
    ],
    [
      "station with an extra key",
      { ...base(), stations: [{ ...unmet, secret: "leaked" }] },
      "Station is not a strict declared station.",
    ],
    [
      "unknown reachability",
      {
        ...base(),
        stations: [
          { ...unmet, reachability: "maybe", unreachableRationale: "Because." },
        ],
      },
      "Unknown reachability.",
    ],
    [
      "both guidance arms",
      {
        ...base(),
        stations: [
          {
            ...unmet,
            guidance: {
              next: { kind: "instruction", text: "Repair it." },
              handoff: {
                owner: "human",
                reason: "R.",
                inspect: [{ kind: "instruction", text: "Look." }],
              },
            },
          },
        ],
      },
      "Wrong guidance arm.",
    ],
    [
      "delay policy with an extra key",
      {
        ...base(),
        stations: [{ ...unmet, retryDelayPolicy: { kind: "none", extra: 1 } }],
      },
      "Unexpected delay policy.",
    ],
    [
      "inspect command with ifNoResult",
      {
        ...base(),
        ifNoResult: { step: { kind: "command", command: "x.raw", args: [] } },
      },
      "An inspect command has no ifNoResult.",
    ],
  ];
  expect(variants).toHaveLength(7);
  expect(variants.map(([name, raw]) => [name, refusalOf(admit(raw))])).toEqual(
    variants.map(([name, , refusal]) => [name, refusal]),
  );
  // Twin: the typed declaration, spread into a raw object, is admitted.
  expect(admit({ ...base(), stations: [unmet] })).not.toThrow();
});

// Host coordination refusals for a raw changing declaration.
const hold = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;
const coordinationCauses = { HELD: hold, PRIOR: hold } as const;
function coordinationStation(causeCode: "HELD" | "PRIOR") {
  return station(coordinationCauses, {
    commandIdentity: "x.change",
    causeCode,
    trigger: "Coordination refusal.",
    repairAction: "Inspect the lock.",
    guidance: {
      handoff: {
        owner: "operator",
        reason: "Inspect the lock owner.",
        inspect: [{ kind: "instruction", text: "Inspect the lock." }],
      },
    },
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
    independentObservable: "swarm-declarations",
  });
}
const rawChange = {
  commandIdentity: "x.change",
  route: ["change"],
  summary: "Change.",
  effectClass: "repository-local",
  effects: ["e"],
  heldLockCause: "HELD",
  unresolvedCaseCause: "PRIOR",
  input: emptyInput,
  stations: [coordinationStation("HELD"), coordinationStation("PRIOR")],
  capabilities: {},
  execute: neverRuns,
};

test("S2.raw-shape-refusals: each shape rule contractFor re-checks names its own refusal", () => {
  // The changing() and station() rules, applied to raw declarations
  // (WIRE-15, WIRE-1, DISC-8; repair 1, S1 and S2).
  const variants: readonly (readonly [string, object, string])[] = [
    [
      "unknown effect class",
      { ...rawChange, effectClass: "bogus" },
      "Unknown effect class.",
    ],
    [
      "no effects",
      { ...rawChange, effects: [] },
      "Invalid changing declaration.",
    ],
    [
      "duplicate effects",
      { ...rawChange, effects: ["e", "e"] },
      "Invalid changing declaration.",
    ],
    [
      "equal coordination causes",
      { ...rawChange, unresolvedCaseCause: "HELD" },
      "Changing commands need distinct coordination refusal stations.",
    ],
    [
      "station row with an extra key",
      { ...base(), stations: [{ ...unmet, row: { ...unmet.row, extra: 1 } }] },
      "Station is not a strict declared station.",
    ],
  ];
  expect(variants).toHaveLength(5);
  expect(variants.map(([name, raw]) => [name, refusalOf(admit(raw))])).toEqual(
    variants.map(([name, , refusal]) => [name, refusal]),
  );
  // Twin: the raw changing declaration passes every shape rule and is then
  // refused for the next rule in order, the missing state add-on.
  expect(refusalOf(admit(rawChange))).toBe(
    "Changing commands require the state add-on.",
  );
});
