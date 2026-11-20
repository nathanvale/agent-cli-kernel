import { expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../kernel/src/kernel/index.ts";
import {
  authority,
  resource,
} from "../../../kernel/src/kernel/validation/brands.ts";
import { record } from "../../../kernel/src/kernel/validation/primitives.ts";
import { inertState } from "../kernel-repair/shapes.ts";
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

const granted = station(commonCauses, {
  commandIdentity: "grants.read",
  causeCode: "SUCCESS_UNCHANGED",
  trigger: "The granted item was read.",
  guidance: { next: { kind: "done" } },
  repairAction: null,
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "grants:read",
});
const defaults = command({
  identity: "grants.read",
  route: ["read"],
  summary: "Read one granted item.",
  input: none,
  capabilities: { approval: true },
  approval: () => ({
    authority: authority("grants.desk"),
    resource: resource("grants.item"),
    resourceRevision: "1",
    effects: [],
  }),
  stations: [granted],
  run: (_input, context) =>
    context.result(granted, { message: "Read.", data: null, effects: empty }),
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
  approval: () => ({
    authority: authority("grants.desk"),
    resource: resource("grants.item"),
    resourceRevision: "1",
    effects: [],
  }),
  stations: [ownedDenial],
  run: (_input, context) =>
    context.result(ownedDenial, {
      message: "Not approved.",
      data: null,
      effects: empty,
    }),
});

const contract = contractFor({
  cli: "grants",
  commands: [defaults, owned],
  state: inertState("grants"),
  installedAddons: ["state", "approval"],
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
