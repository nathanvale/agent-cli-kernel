import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { neverRuns, readsUnchanged } from "./handlers.ts";
import { contractUnchecked } from "./harness.ts";
import { approvedRead } from "./swarm-commands.ts";
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

test("F1.unguarded-raw-refused: a declaration without the two-phase entry may not declare approval", () => {
  // CMD-9 steps 5 and 6: the approval guard precedes handler entry for every
  // admitted declaration. Only command() and changing() register the
  // two-phase entry, so a raw or spread declaration that declares approval
  // (or changes state; see the state twin) is refused (delta review F1).
  const refusal =
    "A command that declares approval or changes state must be built with command() or changing().";
  const guarded = approvedRead(() => undefined);
  const admitGuarded = (declaration: object) => () =>
    contractUnchecked(contractFor, {
      cli: "x",
      commands: [declaration],
      installedAddons: ["approval"],
    });
  expect(refusalOf(admitGuarded({ ...guarded }))).toBe(refusal);
  expect(refusalOf(admitGuarded({ ...guarded, execute: neverRuns }))).toBe(
    refusal,
  );
  // Twins: the constructed declaration is admitted, and a raw declaration
  // that declares no approval stays admitted (X-K1-5).
  expect(refusalOf(admitGuarded(guarded))).toBe("admitted");
  expect(refusalOf(admit({ ...base(), stations: [unmet] }))).toBe("admitted");
});

test("X-K1-3.case-b-station-table: an inspect command that declares approval declares its station table", () => {
  // DISC-10: only an inspect command that declares no approval and no cause
  // of its own may omit a station table.
  const refusal =
    "An inspect command that declares approval declares its station table.";
  const tableless = () =>
    command({
      identity: "x.read",
      route: ["read"],
      summary: "Read one granted item.",
      input: emptyInput,
      capabilities: { approval: true },
      approval: () => {
        throw new Error("Never asked.");
      },
      run: readsUnchanged("x.read"),
    });
  expect(refusalOf(tableless)).toBe(refusal);
  // The raw form of the same declaration is refused by contractFor too.
  const { stations: _stations, ...withoutTable } = approvedRead(
    () => undefined,
  );
  void _stations;
  expect(
    refusalOf(() =>
      contractUnchecked(contractFor, {
        cli: "x",
        commands: [{ ...withoutTable, stations: [] }],
        installedAddons: ["approval"],
      }),
    ),
  ).toBe(refusal);
  // Twin: with its own station table the command is admitted.
  expect(
    refusalOf(() =>
      contractFor({
        cli: "x",
        commands: [approvedRead(() => undefined)],
        installedAddons: ["approval"],
      }),
    ),
  ).toBe("admitted");
});
