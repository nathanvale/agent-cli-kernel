import { afterEach, expect } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "../../../kernel/src/kernel/index.ts";
import type {
  ApprovalRequest,
  ApprovalRuntime,
  CauseTable,
  EffectTransaction,
} from "../../../kernel/src/kernel/index.ts";
import { stateAddon } from "../../../kernel/src/addons/state/index.ts";
import type {
  Declaration,
  ScopeDeclaration,
  TransactionResult,
} from "../../../kernel/src/addons/state/index.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import { testFolder } from "../../support/test-folder.ts";
import { supportingTest } from "./harness.ts";

const causes = {
  DOMAIN_IB_LOCK_HELD: refusedHandoff,
  DOMAIN_IB_UNRESOLVED: refusedHandoff,
  DOMAIN_IB_UNAVAILABLE: refusedHandoff,
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Manual check required.",
    inspect: [{ kind: "command", command: "ib.pending", args: [] }],
  },
} as const;

type Effects = "note.write";
const defaultEffects: readonly [Effects, ...Effects[]] = ["note.write"];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function stateRoot(): string {
  const folder = testFolder("c3-ib-");
  folders.push(folder);
  return join(folder, "state");
}

function keyScope(key: string): ScopeDeclaration {
  return { resources: [{ resource: "note", key }] };
}

function revisionMap(
  value: unknown,
  key = "note",
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return out;
}

const approvalBoundary = contractFor({
  cli: "ib-approval",
  commands: [],
}).boundary;

function customApproval(
  preview: string,
  calls: { count: number },
): NonNullable<Declaration["approval"]> {
  const runtime: ApprovalRuntime = {
    check: () => Promise.resolve(true),
    revalidateAndConsume: () => {
      calls.count += 1;
      return Promise.resolve({ consumed: true });
    },
  };
  const request: ApprovalRequest = {
    authority: approvalBoundary.authority("ib.authority"),
    resource: approvalBoundary.resource("note"),
    resourceRevision: "rev-1",
    effects: defaultEffects,
    preview,
  };
  return { runtime, request };
}

function actorStations() {
  return [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ib.apply",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Completed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "ib.apply:done",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ib.apply",
      causeCode: "DOMAIN_IB_LOCK_HELD",
      trigger: "Held.",
      repairAction: "Wait.",
      guidance: handoff,
      independentObservable: "ib.apply:held",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ib.apply",
      causeCode: "DOMAIN_IB_UNRESOLVED",
      trigger: "Unresolved.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "ib.apply:unresolved",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "ib.apply",
      causeCode: "DOMAIN_IB_UNAVAILABLE",
      trigger: "Unavailable.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: "ib.apply:unavailable",
    }),
  ];
}

function pendingCommand() {
  return command({
    identity: "ib.pending",
    route: ["pending"],
    summary: "Pending.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "ib.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: { next: { kind: "instruction", text: "Inspect." } },
        independentObservable: "ib.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "ib.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
}

function actorCommand(
  state: ReturnType<typeof stateAddon>,
  declaration: Declaration,
  record: { outcome?: TransactionResult<Effects> },
) {
  return changing({
    identity: "ib.apply",
    route: ["apply"],
    summary: "Apply.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_IB_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_IB_UNRESOLVED",
    stations: actorStations(),
    run: async (_input, context) => {
      record.outcome = await state.transaction(
        context.state,
        declaration,
        async (transaction: EffectTransaction<Effects>) => {
          await transaction.record(
            "note.write",
            () => Promise.resolve(),
            () => Promise.resolve(true),
          );
        },
      );
      if (record.outcome.kind !== "ran")
        return context.result(
          { commandIdentity: "ib.apply", causeCode: "DOMAIN_IB_UNAVAILABLE" },
          { message: record.outcome.kind, data: null, effects: unchanged },
        );
      return context.result(
        { commandIdentity: "ib.apply", causeCode: "SUCCESS_COMPLETED" },
        { message: "ran", data: null, transaction: record.outcome.proof },
      );
    },
  });
}

async function runInHost(
  root: string,
  declaration: Declaration,
): Promise<{
  readonly outcome: TransactionResult<Effects> | undefined;
  readonly report: ReturnType<ReturnType<typeof stateAddon>["report"]>;
}> {
  const state = stateAddon({
    root,
    report: "ib.pending",
    admissionWaitMilliseconds: 300,
  });
  const record: { outcome?: TransactionResult<Effects> } = {};
  const contract = contractFor({
    cli: "ib",
    commands: [pendingCommand(), actorCommand(state, declaration, record)],
    causes: allCauses,
    state: state.descriptor,
    installedAddons: ["state"],
  });
  await runInProcess(contract, {
    emergencyRecord: state.emergencyRecord,
  })(["apply"]);
  return { outcome: record.outcome, report: state.report() };
}

function storeOperationNames(root: string): readonly string[] {
  const operations = join(root, "operations");
  return existsSync(operations) ? readdirSync(operations).sort() : [];
}

async function assertRefusedAndUsable(
  root: string,
  declaration: Declaration,
): Promise<void> {
  const beforeOps = storeOperationNames(root);
  const refused = await runInHost(root, declaration);
  expect(refused.outcome?.kind).toBe("unavailable");
  if (refused.outcome?.kind === "unavailable")
    expect(refused.outcome.reason).toBe("declaration");
  expect(refused.outcome?.proof.transactionState).toBe("unchanged");
  expect(storeOperationNames(root)).toEqual(beforeOps);
  expect(refused.report).not.toEqual({ ok: false, reason: "corrupt" });

  const unrelated = await runInHost(root, {
    command: "ib.apply",
    scope: keyScope("beta"),
  });
  expect(unrelated.outcome?.kind).toBe("ran");
  expect(unrelated.report).toEqual({ ok: true, unfinished: [] });

  const sameKey = await runInHost(root, {
    command: "ib.apply",
    scope: keyScope("alpha"),
  });
  expect(sameKey.outcome?.kind).toBe("ran");
  expect(sameKey.report).toEqual({ ok: true, unfinished: [] });
}

const invalidRevisionValues: readonly {
  readonly label: string;
  readonly value: unknown;
}[] = [
  { label: "empty-string", value: "" },
  { label: "number", value: 42 },
  { label: "null", value: null },
];

supportingTest(
  "IB01.unflagged-invalid-revision-refused: unflagged path refuses empty, numeric, and null revision values with declaration and keeps root usable",
  async () => {
    for (const entry of invalidRevisionValues) {
      const root = stateRoot();
      await assertRefusedAndUsable(root, {
        command: "ib.apply",
        scope: keyScope("alpha"),
        revisions: revisionMap(entry.value),
      });
    }
  },
);

supportingTest(
  "IB02.flagged-invalid-revision-refused: flagged path refuses empty, numeric, and null revision values with declaration and keeps root usable",
  async () => {
    for (const entry of invalidRevisionValues) {
      const root = stateRoot();
      await assertRefusedAndUsable(root, {
        command: "ib.apply",
        scope: keyScope("alpha"),
        revisions: revisionMap(entry.value),
        supersedeUnresolved: true,
      });
    }
  },
);

supportingTest(
  "IB03.unflagged-invalid-revision-after-approval: unflagged path consumes approval before refusing invalid revision with declaration",
  async () => {
    const root = stateRoot();
    const calls = { count: 0 };
    await assertRefusedAndUsable(root, {
      command: "ib.apply",
      scope: keyScope("alpha"),
      revisions: revisionMap(""),
      approval: customApproval("preview-ib-order", calls),
    });
    expect(calls.count).toBe(1);
  },
);

supportingTest(
  "IB04.unflagged-empty-preview-refused: unflagged path refuses empty preview from custom approval runtime with declaration and keeps root usable",
  async () => {
    const root = stateRoot();
    const calls = { count: 0 };
    await assertRefusedAndUsable(root, {
      command: "ib.apply",
      scope: keyScope("alpha"),
      approval: customApproval("", calls),
    });
    expect(calls.count).toBe(1);
  },
);

supportingTest(
  "IB05.flagged-empty-preview-refused: flagged path refuses empty preview from custom approval runtime with declaration and keeps root usable",
  async () => {
    const root = stateRoot();
    const calls = { count: 0 };
    await assertRefusedAndUsable(root, {
      command: "ib.apply",
      scope: keyScope("alpha"),
      approval: customApproval("", calls),
      supersedeUnresolved: true,
    });
    expect(calls.count).toBe(0);
  },
);

supportingTest(
  "IB06.valid-revision-and-preview-accepted: non-empty revision and preview succeed on both unflagged and flagged paths",
  async () => {
    for (const flagged of [false, true]) {
      const root = stateRoot();
      const calls = { count: 0 };
      const result = await runInHost(root, {
        command: "ib.apply",
        scope: keyScope("alpha"),
        revisions: revisionMap("rev-1"),
        approval: customApproval("preview-ib-ok", calls),
        ...(flagged ? { supersedeUnresolved: true } : {}),
      });
      expect(result.outcome?.kind).toBe("ran");
      expect(result.report).toEqual({ ok: true, unfinished: [] });
      expect(calls.count).toBe(1);
    }
  },
);

const invalidProtoRevisionValues: readonly unknown[] = [
  "",
  42,
  null,
  { bad: "" },
];

supportingTest(
  "IB07.unflagged-proto-invalid-revision-refused: unflagged path refuses empty, numeric, null, and object values under an own __proto__ revision key with declaration and keeps root usable",
  async () => {
    for (const value of invalidProtoRevisionValues) {
      const root = stateRoot();
      await assertRefusedAndUsable(root, {
        command: "ib.apply",
        scope: keyScope("alpha"),
        revisions: revisionMap(value, "__proto__"),
      });
    }
  },
);

supportingTest(
  "IB08.flagged-proto-invalid-revision-refused: flagged path refuses empty, numeric, null, and object values under an own __proto__ revision key with declaration and keeps root usable",
  async () => {
    for (const value of invalidProtoRevisionValues) {
      const root = stateRoot();
      await assertRefusedAndUsable(root, {
        command: "ib.apply",
        scope: keyScope("alpha"),
        revisions: revisionMap(value, "__proto__"),
        supersedeUnresolved: true,
      });
    }
  },
);
