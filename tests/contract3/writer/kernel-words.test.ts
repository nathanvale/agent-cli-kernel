// B3 (Nathan, 16 November 2026): on DOMAIN_AUTHORITY_REQUIRED, naming the
// authority owner's role is enough and the owner is `human`; the base's
// default words are binding. A command may declare its own tuple (DISC-11b)
// and is not required to. Expected words are test-owned literals.
import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import { authorityDefaults } from "../lifecycle/checks.ts";

const none = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const declaredWords = {
  guidance: {
    handoff: {
      owner: "operator",
      reason: "The grants desk must approve this item.",
      inspect: [{ kind: "instruction", text: "Grants desk: review the item." }],
    },
  },
  repairAction: "Ask the grants desk for an exact-item grant.",
} as const;

function stations(data: unknown): readonly Record<string, unknown>[] {
  const list: readonly unknown[] =
    record(data) && Array.isArray(data.stations) ? data.stations : [];
  return list.filter((item) => record(item));
}
function stationOf(data: unknown, causeCode: string): Record<string, unknown> {
  const found = stations(data).find((item) => item.causeCode === causeCode);
  if (!found) throw new Error(`No ${causeCode} station.`);
  return found;
}

const defaults = command({
  identity: "grants.read",
  route: ["read"],
  summary: "Read one granted item.",
  input: none,
  capabilities: { approval: true },
  run: (_input, context) =>
    context.result(
      { commandIdentity: "grants.read", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Read.", data: null, effects: empty },
    ),
});

const ownedDenial = station(commonCauses, {
  commandIdentity: "grants.owned",
  causeCode: "DOMAIN_AUTHORITY_REQUIRED",
  trigger: "The grants desk has not approved this item.",
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "grants:owned-denial",
  ...declaredWords,
});
const owned = command({
  identity: "grants.owned",
  route: ["owned"],
  summary: "Read one item the grants desk approves.",
  input: none,
  capabilities: { approval: true },
  stations: [ownedDenial],
  run: (_input, context) =>
    context.result(ownedDenial, {
      message: "Not approved.",
      data: null,
      effects: empty,
    }),
});

// Admitted without declaring the tuple: no requirement to declare it.
const contract = contractFor({
  cli: "grants",
  commands: [defaults, owned],
  installedAddons: ["approval"],
});

test("B3.01.default-words-exact", () => {
  const data = contract.discoverCommand("grants.read");
  const denial = stationOf(data, "DOMAIN_AUTHORITY_REQUIRED");
  expect({
    guidance: denial.guidance,
    repairAction: denial.repairAction,
  }).toEqual(authorityDefaults);
  const internal = stations(data).filter((item) =>
    String(item.causeCode).startsWith("INTERNAL_RESULT_"),
  );
  expect(internal.length).toBeGreaterThan(0);
  for (const item of internal) {
    expect(item.guidance).not.toEqual(denial.guidance);
    expect(item.repairAction).not.toBe(denial.repairAction);
  }
});

test("B3.03.declared-tuple-overrides-only-its-command", () => {
  const ownedDenialStation = stationOf(
    contract.discoverCommand("grants.owned"),
    "DOMAIN_AUTHORITY_REQUIRED",
  );
  expect({
    guidance: ownedDenialStation.guidance,
    repairAction: ownedDenialStation.repairAction,
  }).toEqual(declaredWords);
  const defaultStation = stationOf(
    contract.discoverCommand("grants.read"),
    "DOMAIN_AUTHORITY_REQUIRED",
  );
  expect({
    guidance: defaultStation.guidance,
    repairAction: defaultStation.repairAction,
  }).toEqual(authorityDefaults);
});
