import { expect } from "bun:test";
import { runFamily, stateFixture } from "./harness.ts";

let observations: Promise<unknown> | undefined;
async function observed(id: string): Promise<unknown> {
  observations ??= stateFixture("state-repair");
  const all = await observations;
  expect(all).toBeObject();
  return Reflect.get(Object(all), id);
}
const refused = { admitted: false, consumed: 0 };

runFamily(
  "R01",
  {
    "R01.second-transaction-refused": async () =>
      expect(await observed("R01.second-transaction-refused")).toEqual({
        executed: true,
        built: { ok: true, causeCode: "SUCCESS_UNCHANGED", completed: [] },
        ledger: [],
        workStarts: 1,
        second: "rejected",
      }),
    "R01.overlapping-transaction-refused": async () =>
      expect(await observed("R01.overlapping-transaction-refused")).toEqual({
        executed: true,
        built: { ok: true, causeCode: "SUCCESS_COMPLETED", completed: ["e"] },
        ledger: ["e"],
        workStarts: 1,
        overlap: ["fulfilled", "rejected"],
      }),
    "R01.single-proof-per-attachment": async () =>
      expect(await observed("R01.single-proof-per-attachment")).toEqual({
        executed: true,
        built: { ok: true, causeCode: "SUCCESS_UNCHANGED", completed: [] },
        ledger: [],
        workStarts: 1,
        secondProof: "refused",
      }),
    "R01.refusal-after-effect-refused": async () =>
      expect(await observed("R01.refusal-after-effect-refused")).toEqual({
        executed: true,
        built: { ok: false, path: "transaction" },
        ledger: ["e"],
        workStarts: 1,
      }),
    "R01.refusal-after-unchanged-admitted": async () =>
      expect(await observed("R01.refusal-after-unchanged-admitted")).toEqual({
        executed: true,
        built: { ok: true, causeCode: "HELD", completed: [] },
        ledger: [],
        workStarts: 1,
      }),
    "R01.completed-twin": async () =>
      expect(await observed("R01.completed-twin")).toEqual({
        executed: true,
        built: { ok: true, causeCode: "SUCCESS_COMPLETED", completed: ["e"] },
        ledger: ["e"],
        workStarts: 1,
      }),
    "R01.foreign-proof-refused": async () =>
      expect(await observed("R01.foreign-proof-refused")).toEqual({
        executed: true,
        own: true,
        otherRun: "transaction",
        otherInstallation: "transaction",
      }),
  },
  60000,
);

runFamily(
  "R02",
  {
    "R02.public-index-export": async () =>
      expect(await observed("R02.public-index-export")).toEqual({
        exported: true,
      }),
    "R02.plain-object-refused": async () =>
      expect(await observed("R02.plain-object-refused")).toEqual(refused),
    "R02.copy-refused": async () =>
      expect(await observed("R02.copy-refused")).toEqual({
        spread: refused,
        symbolCarrier: refused,
        cloneError: "DataCloneError",
      }),
    "R02.other-run-refused": async () =>
      expect(await observed("R02.other-run-refused")).toEqual({
        ...refused,
        directOtherRun: false,
        unattachedIssue: { issued: false, namesAttachment: true },
      }),
    "R02.other-installation-refused": async () =>
      expect(await observed("R02.other-installation-refused")).toEqual(refused),
    "R02.issued-twin-consumed-once": async () =>
      expect(await observed("R02.issued-twin-consumed-once")).toEqual({
        admitted: true,
        consumed: 1,
        direct: true,
      }),
    "R02.inactive-refused": async () =>
      expect(await observed("R02.inactive-refused")).toEqual({
        ...refused,
        directInactive: false,
        directThrowing: false,
      }),
    "R02.superseded-attachment-refused": async () =>
      expect(await observed("R02.superseded-attachment-refused")).toEqual(
        refused,
      ),
  },
  60000,
);
