import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../kernel/src/kernel/index.ts";
import { neverRuns, readsUnchanged } from "./handlers.ts";
import { contractUnchecked } from "./harness.ts";
import { approvedRead } from "./swarm-commands.ts";
import { emptyInput, inertState, unchanged } from "./shapes.ts";

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
function admit(raw: unknown) {
  return () => contractUnchecked(contractFor, { cli: "x", commands: [raw] });
}

test("X-K1-5.raw-declaration-admission: contractFor re-checks every constructor rule on a raw declaration", () => {
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
      "Station is not a strict declared station. Repair: declare a strict station with a cause row matching Command Contract 3; carriesData: true is allowed only on an unchanged domain refusal.",
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
  expect(admit({ ...base(), stations: [unmet] })).not.toThrow();
});

const hold = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;
const coordinationCauses = { DOMAIN_HELD: hold, DOMAIN_PRIOR: hold } as const;
function coordinationStation(causeCode: "DOMAIN_HELD" | "DOMAIN_PRIOR") {
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
  heldLockCause: "DOMAIN_HELD",
  unresolvedCaseCause: "DOMAIN_PRIOR",
  input: emptyInput,
  stations: [
    coordinationStation("DOMAIN_HELD"),
    coordinationStation("DOMAIN_PRIOR"),
  ],
  capabilities: {},
  execute: neverRuns,
};

test("S2.raw-shape-refusals: each shape rule contractFor re-checks names its own refusal", () => {
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
      { ...rawChange, unresolvedCaseCause: "DOMAIN_HELD" },
      "Changing commands need distinct coordination refusal stations.",
    ],
    [
      "station row with an extra key",
      { ...base(), stations: [{ ...unmet, row: { ...unmet.row, extra: 1 } }] },
      "Station is not a strict declared station. Repair: declare a strict station with a cause row matching Command Contract 3; carriesData: true is allowed only on an unchanged domain refusal.",
    ],
  ];
  expect(variants).toHaveLength(5);
  expect(variants.map(([name, raw]) => [name, refusalOf(admit(raw))])).toEqual(
    variants.map(([name, , refusal]) => [name, refusal]),
  );
  expect(refusalOf(admit(rawChange))).toBe(
    "Changing commands require the state add-on.",
  );
});

test("F1.unguarded-raw-refused: a declaration without the two-phase entry may not declare approval", () => {
  const refusal =
    "A command that declares approval or changes state must be built with command() or changing().";
  const guarded = approvedRead(() => undefined);
  const admitGuarded = (declaration: unknown) => () =>
    contractUnchecked(contractFor, {
      cli: "x",
      commands: [declaration],
      state: inertState("x"),
      installedAddons: ["state", "approval"],
    });
  expect(refusalOf(admitGuarded({ ...guarded }))).toBe(refusal);
  expect(refusalOf(admitGuarded({ ...guarded, execute: neverRuns }))).toBe(
    refusal,
  );
  expect(refusalOf(admitGuarded(guarded))).toBe("admitted");
  expect(refusalOf(admit({ ...base(), stations: [unmet] }))).toBe("admitted");
});

test("X-K1-3.case-b-station-table: an inspect command that declares approval declares its station table", () => {
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
  const { stations: _stations, ...withoutTable } = approvedRead(
    () => undefined,
  );
  void _stations;
  expect(
    refusalOf(() =>
      contractUnchecked(contractFor, {
        cli: "x",
        commands: [{ ...withoutTable, stations: [] }],
        state: inertState("x"),
        installedAddons: ["state", "approval"],
      }),
    ),
  ).toBe(refusal);
  expect(
    refusalOf(() =>
      contractFor({
        cli: "x",
        commands: [approvedRead(() => undefined)],
        state: inertState("x"),
        installedAddons: ["state", "approval"],
      }),
    ),
  ).toBe("admitted");
});

test("S3.approval-needs-state: contractFor refuses the approval add-on installed without the state add-on", () => {
  const refusal =
    "Approval requires the state add-on: list state in installedAddons and pass the add-on made by contractFor.stateAddon.";
  expect(
    refusalOf(() =>
      contractFor({
        cli: "x",
        commands: [approvedRead(() => undefined)],
        installedAddons: ["approval"],
      }),
    ),
  ).toBe(refusal);
  expect(
    refusalOf(() =>
      contractFor({
        cli: "x",
        commands: [],
        installedAddons: ["approval", "programs"],
      }),
    ),
  ).toBe(refusal);
  expect(
    refusalOf(() =>
      contractFor({
        cli: "x",
        commands: [approvedRead(() => undefined)],
        state: inertState("x"),
        installedAddons: ["state", "approval"],
      }),
    ),
  ).toBe("admitted");
});
