import { expect, test } from "bun:test";
import { contractFor } from "../../starters/contract3/src/kernel/index.ts";

test("the contract preserves every independently specified common cause correlation", () => {
  const contract = contractFor({ cli: "specimen", commands: [] });
  // Independent oracle: WIRE-18, admitted T0 expectation table, not a production projection.
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
      data: null,
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
