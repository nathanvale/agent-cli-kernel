import expected from "./common-causes.json";
import { expect, test } from "bun:test";
import {
  contractFor,
  versionReader,
} from "../../starters/contract3/src/kernel/index.ts";

test("the contract preserves every independently specified common cause correlation", () => {
  const contract = contractFor({ cli: "specimen", commands: [] });
  expect(Object.keys(contract.causes)).toHaveLength(20);
  expect(contract.causes.SUCCESS_UNCHANGED).toEqual({
    outcome: "success",
    transactionState: "unchanged",
    failureClass: null,
    exitCode: 0,
    retryable: false,
    guidance: "next",
  });
  expect(contract.causes.TRANSIENT_NOT_STARTED).toEqual({
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "transient",
    exitCode: 75,
    retryable: true,
    guidance: "next",
  });
  expect(contract.causes.INTERNAL_RESULT_UNKNOWN).toEqual({
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "internal",
    exitCode: 1,
    retryable: false,
    guidance: "handoff",
  });
});

test("external versions are classified before shape and JSON ingress rejects unsafe values", async () => {
  const contract = contractFor({ cli: "specimen", commands: [] });
  expect(contract.classifyVersion("2.0.0")).toBe("other-major");
  expect(contract.classifyVersion("3.1.0")).toBe("newer-minor");
  expect(contract.classifyVersion("3.0.1")).toBe("malformed");
  expect(contract.classifyVersion("3.0.0")).toBe("accepted");
  expect(
    await contract.validate({ contractVersion: "2.0.0", data: new Date() }),
  ).toMatchObject({
    ok: false,
    path: "contractVersion",
    reason: "other-major",
  });
  expect(
    (await contract.validate({ contractVersion: "3.0.0", data: undefined })).ok,
  ).toBe(false);
});

test("a valid inspect envelope is accepted and wrong correlations are rejected", async () => {
  const contract = contractFor({ cli: "specimen", commands: [] });
  const envelope = {
    contractVersion: "3.0.0",
    message: "Available commands.",
    availablePaths: ["specimen.discovery"],
    result: {
      runId: "run-1",
      commandIdentity: "specimen.discovery",
      outcome: "success",
      effectClass: "inspect",
      transactionState: "unchanged",
      causeCode: "SUCCESS_UNCHANGED",
      failureClass: null,
      exitCode: 0,
      data: contract.discover(),
      retryable: false,
      repairAction: null,
      effects: {
        completed: [],
        remaining: [],
        uncertain: [],
        inventoryComplete: true,
      },
      next: { kind: "done" },
    },
  };
  expect((await contract.validate(envelope)).ok).toBe(true);
  for (const mutation of [
    { exitCode: 75 },
    { transactionState: "unknown" },
    { retryable: true },
    {
      handoff: {
        owner: "human",
        reason: "Inspect.",
        inspect: [{ kind: "instruction", text: "Inspect resource." }],
      },
    },
    { data: new Date() },
    { attemptedEffect: "write" },
  ]) {
    expect(
      (
        await contract.validate({
          ...envelope,
          result: { ...envelope.result, ...mutation },
        })
      ).ok,
    ).toBe(false);
  }
});

test("all twenty common cause rows match the independently admitted oracle", () => {
  const contract = contractFor({ cli: "specimen", commands: [] });
  expect(expected.rows).toHaveLength(20);
  expect(Object.keys(contract.causes).sort()).toEqual(
    expected.rows.map((row) => row.causeCode).sort(),
  );
  for (const expectedRow of expected.rows) {
    const actual: unknown = Reflect.get(contract.causes, expectedRow.causeCode);
    const { causeCode, guidance, ...fields } = expectedRow;
    expect(causeCode.length).toBeGreaterThan(0);
    expect(actual).toEqual({
      ...fields,
      guidance: guidance === "H" ? "handoff" : "next",
    });
  }
});

test("test-only minor tables retain old meanings and reject incompatible evolution", () => {
  const base = {
    minor: 0,
    fields: { message: { required: true, meaning: "Observed result." } },
    commonCauses: ["SUCCESS_UNCHANGED"],
  } as const;
  const next = {
    minor: 1,
    fields: {
      ...base.fields,
      hint: {
        required: false,
        meaning:
          "Optional additional context; absence preserves the prior result.",
      },
    },
    commonCauses: base.commonCauses,
  } as const;
  const reader = versionReader([base, next]);
  expect(reader.classify("3.0.0")).toBe("accepted");
  expect(reader.classify("3.1.0")).toBe("accepted");
  expect(reader.classify("3.2.0")).toBe("newer-minor");
  expect(reader.classify("4.0.0")).toBe("other-major");
  expect(reader.classify("3.0.1")).toBe("malformed");
  expect(reader.classify("3.0")).toBe("malformed");
  expect(reader.fields("3.0.0", { message: "Read." })).toBe(true);
  expect(reader.fields("3.0.0", { message: "Read.", hint: "future" })).toBe(
    false,
  );
  expect(reader.fields("3.1.0", { message: "Read." })).toBe(true);
  expect(reader.meaning("3.0.0", "message")).toBe("Observed result.");
  for (const fields of [
    {},
    { renamed: base.fields.message },
    {
      ...base.fields,
      hint: { required: true, meaning: "New required field." },
    },
    { message: { required: true, meaning: "Changed meaning." } },
  ])
    expect(() => versionReader([base, { ...next, fields }])).toThrow();
  expect(() =>
    versionReader([
      base,
      { ...next, commonCauses: [...base.commonCauses, "NEW_COMMON_CAUSE"] },
    ]),
  ).toThrow();
});

test("admitted cause rows cannot be changed through discovery or the original input object", () => {
  const custom = {
    outcome: "success",
    transactionState: "unchanged",
    failureClass: null,
    exitCode: 0,
    retryable: false,
    guidance: "next",
  } as const;
  const contract = contractFor({
    cli: "specimen",
    commands: [],
    causes: { READ_COMPLETE: custom },
  });
  Reflect.set(custom, "exitCode", 75);
  expect(contract.causes.READ_COMPLETE?.exitCode).toBe(0);
  expect(Reflect.set(contract.causes.READ_COMPLETE ?? {}, "exitCode", 75)).toBe(
    false,
  );
  expect(contract.causes.READ_COMPLETE?.exitCode).toBe(0);
});
