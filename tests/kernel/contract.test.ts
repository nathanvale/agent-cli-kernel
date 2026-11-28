import expected from "./common-causes.json";
import { expect, test } from "bun:test";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
  versionReader,
} from "../../kernel/src/kernel/index.ts";
import type { TransactionProof } from "../../kernel/src/kernel/index.ts";
import {
  attachState,
  createStateAddon,
} from "../../kernel/src/kernel/state-seam.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "./kernel-repair/shapes.ts";

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
    causes: { SUCCESS_READ_COMPLETE: custom },
  });
  Reflect.set(custom, "exitCode", 75);
  expect(contract.causes.SUCCESS_READ_COMPLETE?.exitCode).toBe(0);
  expect(
    Reflect.set(contract.causes.SUCCESS_READ_COMPLETE ?? {}, "exitCode", 75),
  ).toBe(false);
  expect(contract.causes.SUCCESS_READ_COMPLETE?.exitCode).toBe(0);
});

test("build ignores prototype-inherited run facts and reads own facts once", async () => {
  const inspectStation = station(commonCauses, {
    commandIdentity: "specimen.inspect",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Inspection completed.",
    guidance: {
      next: { kind: "instruction", text: "Review reported data." },
    },
    repairAction: null,
    independentObservable: "Reported data.",
    ...stationWords,
  });
  const inspectCommand = command({
    identity: "specimen.inspect",
    route: ["inspect"],
    summary: "Inspect specimen state.",
    input: emptyInput,
    capabilities: {},
    stations: [inspectStation],
    run: (_input, context) =>
      context.result(inspectStation, {
        message: "Inspected.",
        data: { ok: true },
        effects: unchanged,
      }),
  });
  const contract = contractFor({
    cli: "specimen",
    commands: [inspectCommand],
  });

  class InheritedDataFacts {
    readonly runId = "run-1";
    readonly effects = unchanged;
    get data() {
      return { leaked: true };
    }
    get message() {
      return "Inherited message.";
    }
  }
  const built = await contract.build(inspectStation, new InheritedDataFacts());
  expect(built).toMatchObject({
    ok: false,
    path: "facts",
    reason: "invalid run facts",
  });

  class InheritedMessageFacts {
    readonly runId = "run-1";
    readonly data = { ok: true };
    readonly effects = unchanged;
    get message() {
      return "Inherited message.";
    }
  }
  const withInheritedMessage = await contract.build(
    inspectStation,
    new InheritedMessageFacts(),
  );
  expect(withInheritedMessage).toMatchObject({
    ok: false,
    path: "$",
    reason: "not plain bounded JSON",
  });

  let runIdReads = 0;
  const getterFacts = {
    data: { ok: true },
    message: "Own message.",
    effects: unchanged,
    get runId(): string {
      runIdReads += 1;
      return runIdReads === 1 ? "run-1" : "run-mutated";
    },
  };
  const once = await contract.build(inspectStation, getterFacts);
  expect(once.ok).toBe(true);
  expect(runIdReads).toBe(1);

  const stateDescriptor = createStateAddon((issuer) => ({
    ifNoResult: issuer.ifNoResult({
      kind: "command",
      command: "specimen.inspect",
      args: [],
    }),
    attach: <Effect extends string>(
      runId: string,
      effects: readonly Effect[],
    ) => ({
      transaction: () => {
        const first = effects[0];
        if (first === undefined)
          throw new Error("Expected at least one declared effect.");
        return Promise.resolve(
          issuer.transactionProof(runId, {
            transactionState: "completed",
            effects: {
              completed: [first],
              remaining: [],
              uncertain: [],
              inventoryComplete: true,
            },
          }),
        );
      },
    }),
  }));
  const completedStation = station(commonCauses, {
    commandIdentity: "specimen.write",
    causeCode: "SUCCESS_COMPLETED",
    trigger: "Write completed.",
    guidance: { next: { kind: "done" } },
    repairAction: null,
    independentObservable: "Written record.",
    ...stationWords,
  });
  const refusedStation = station(commonCauses, {
    commandIdentity: "specimen.write",
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    trigger: "Target missing.",
    guidance: {
      next: { kind: "instruction", text: "Create the target before writing." },
    },
    repairAction: "Create the target before writing.",
    independentObservable: "Target absence.",
    ...stationWords,
  });
  const writeCauses = {
    ...commonCauses,
    DOMAIN_SPECIMEN_LOCK_HELD: refusedHandoff,
    DOMAIN_SPECIMEN_UNRESOLVED: refusedHandoff,
  } as const;
  const heldLockStation = station(writeCauses, {
    commandIdentity: "specimen.write",
    causeCode: "DOMAIN_SPECIMEN_LOCK_HELD",
    trigger: "Another run holds the write lock.",
    guidance: {
      handoff: {
        owner: "operator",
        reason: "Wait for the active write lock before retrying.",
        inspect: [{ kind: "command", command: "specimen.inspect", args: [] }],
      },
    },
    repairAction: "Retry once the active write finishes.",
    independentObservable: "Lock state.",
    ...stationWords,
  });
  const unresolvedStation = station(writeCauses, {
    commandIdentity: "specimen.write",
    causeCode: "DOMAIN_SPECIMEN_UNRESOLVED",
    trigger: "Prior write outcome is unresolved.",
    guidance: {
      handoff: {
        owner: "operator",
        reason: "Inspect the prior write before retrying.",
        inspect: [{ kind: "command", command: "specimen.inspect", args: [] }],
      },
    },
    repairAction: "Inspect the unresolved write.",
    independentObservable: "Target record.",
    ...stationWords,
  });
  const writeCommand = changing({
    identity: "specimen.write",
    route: ["write"],
    summary: "Write specimen state.",
    effectClass: "repository-local",
    effects: ["specimen.note"],
    input: emptyInput,
    capabilities: {},
    ifNoResult: stateDescriptor.ifNoResult,
    heldLockCause: "DOMAIN_SPECIMEN_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_SPECIMEN_UNRESOLVED",
    stations: [
      completedStation,
      refusedStation,
      heldLockStation,
      unresolvedStation,
    ],
    run: async (_input, context) => {
      const transaction = await context.state.transaction(async () => {});
      return context.result(completedStation, {
        message: "Written.",
        data: { ok: true },
        transaction,
      });
    },
  });
  const changingContract = contractFor({
    cli: "specimen",
    installedAddons: ["state"],
    state: stateDescriptor,
    causes: {
      DOMAIN_SPECIMEN_LOCK_HELD: refusedHandoff,
      DOMAIN_SPECIMEN_UNRESOLVED: refusedHandoff,
    },
    commands: [inspectCommand, writeCommand],
  });
  const attached = attachState(stateDescriptor, "run-1", ["specimen.note"]);
  expect(attached).toBeDefined();
  if (!attached) throw new Error("Expected state attachment.");
  const realProof = await attached.capability.transaction(async () => {});

  class InheritedTransactionFacts {
    readonly runId = "run-1";
    readonly data = { ok: true };
    readonly message = "Own message.";
    get transaction(): TransactionProof<"specimen.note"> {
      return realProof;
    }
  }
  const withInheritedTransaction = await changingContract.build(
    completedStation,
    new InheritedTransactionFacts(),
  );
  expect(withInheritedTransaction).toMatchObject({
    ok: false,
    path: "transaction",
    reason: "state-issued transaction proof required",
  });

  let completedRunIdReads = 0;
  const completedGetterFacts = {
    data: { ok: true },
    message: "Own message.",
    transaction: realProof,
    get runId(): string {
      completedRunIdReads += 1;
      return completedRunIdReads === 1 ? "run-1" : "run-mutated";
    },
  };
  const completedBuilt = await changingContract.build(
    completedStation,
    completedGetterFacts,
  );
  expect(completedBuilt.ok).toBe(true);
  expect(completedRunIdReads).toBe(1);

  let refusedRunIdReads = 0;
  const refusedGetterFacts = {
    data: null,
    message: "Not found.",
    effects: unchanged,
    get runId(): string {
      refusedRunIdReads += 1;
      return refusedRunIdReads === 1 ? "run-free" : "run-1";
    },
  };
  const refusedBuilt = await changingContract.build(
    refusedStation,
    refusedGetterFacts,
  );
  expect(refusedBuilt.ok).toBe(true);
  expect(refusedRunIdReads).toBe(1);
  attached.forget();
});
