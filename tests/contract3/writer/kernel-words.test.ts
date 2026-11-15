// K1: the base's default words for an approval denial are their own handoff
// naming the authority owner (CMD-15, WIRE-18, DISC-11b), not the words of an
// internal result-production failure.
import { expect, test } from "bun:test";
import {
  command,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";

const none = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

function stationOf(data: unknown, causeCode: string): Record<string, unknown> {
  const stations: readonly unknown[] =
    record(data) && Array.isArray(data.stations) ? data.stations : [];
  const found = stations.find(
    (item) => record(item) && item.causeCode === causeCode,
  );
  if (!record(found)) throw new Error(`No ${causeCode} station.`);
  return found;
}

test("an approval denial's default handoff names the authority owner, apart from internal-result words", () => {
  const guarded = command({
    identity: "grants.read",
    route: ["read"],
    summary: "Read one granted item.",
    input: none,
    capabilities: { approval: true },
    run: (_input, context) =>
      context.result(
        { commandIdentity: "grants.read", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      ),
  });
  const contract = contractFor({
    cli: "grants",
    commands: [guarded],
    installedAddons: ["approval"],
  });
  const data = contract.discoverCommand("grants.read");
  const denial = stationOf(data, "DOMAIN_AUTHORITY_REQUIRED");
  const internal = stationOf(data, "INTERNAL_RESULT_UNCHANGED");
  const guidance = record(denial.guidance) ? denial.guidance : {};
  const handoff = record(guidance.handoff) ? guidance.handoff : {};
  // Independent expectations from CMD-15: a handoff to a person that owns the
  // authority, and words that are not the result-production handoff.
  expect(handoff.owner).toBe("human");
  expect(String(handoff.reason).toLowerCase()).toContain("authority owner");
  expect(denial.guidance).not.toEqual(internal.guidance);
  expect(denial.repairAction).not.toBe(internal.repairAction);
  expect(String(denial.repairAction).toLowerCase()).toContain(
    "authority owner",
  );
});
