import { afterEach, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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
  ApprovalRuntime,
  CauseTable,
  EffectTransaction,
} from "../../../kernel/src/kernel/index.ts";
import { stateAddonWithTestSeams } from "../../../kernel/src/addons/state/fixture.ts";
import type {
  Declaration,
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
  DOMAIN_CD_LOCK_HELD: refusedHandoff,
  DOMAIN_CD_UNRESOLVED: refusedHandoff,
  DOMAIN_CD_UNAVAILABLE: refusedHandoff,
  DOMAIN_CD_PARTIAL: {
    ...refusedHandoff,
    outcome: "failed",
    transactionState: "partially-completed",
  },
  DOMAIN_CD_UNKNOWN: {
    ...refusedHandoff,
    outcome: "failed",
    transactionState: "unknown",
  },
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };
const defaultEffects = ["doc.write"] as const;
type Effects = (typeof defaultEffects)[number];
const createdFolders: string[] = [];

afterEach(() => {
  while (createdFolders.length > 0) {
    const folder = createdFolders.pop();
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
});

function stateRoot(): string {
  const base = testFolder("cd-once-");
  createdFolders.push(base);
  const root = join(base, "state");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

const cdHandoff = {
  handoff: {
    owner: "operator",
    reason: "Inspect.",
    inspect: [{ kind: "instruction", text: "Inspect." }],
  },
} as const;

function actorStations() {
  return [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "cd.open",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Completed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "cd.open:completed",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "cd.open",
      causeCode: "DOMAIN_CD_LOCK_HELD",
      trigger: "Held.",
      repairAction: "Retry.",
      guidance: cdHandoff,
      independentObservable: "cd.open:held",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "cd.open",
      causeCode: "DOMAIN_CD_UNRESOLVED",
      trigger: "Unresolved.",
      repairAction: "Inspect.",
      guidance: cdHandoff,
      independentObservable: "cd.open:unresolved",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "cd.open",
      causeCode: "DOMAIN_CD_UNAVAILABLE",
      trigger: "Unavailable.",
      repairAction: "Inspect.",
      guidance: cdHandoff,
      independentObservable: "cd.open:unavailable",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "cd.open",
      causeCode: "DOMAIN_CD_PARTIAL",
      trigger: "Partial.",
      repairAction: "Inspect.",
      guidance: cdHandoff,
      independentObservable: "cd.open:partial",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "cd.open",
      causeCode: "DOMAIN_CD_UNKNOWN",
      trigger: "Unknown.",
      repairAction: "Inspect.",
      guidance: cdHandoff,
      independentObservable: "cd.open:unknown",
    }),
  ] as const;
}

function pendingCommand() {
  return command({
    identity: "cd.pending",
    route: ["pending"],
    summary: "Pending.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "cd.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: { next: { kind: "instruction", text: "Inspect." } },
        independentObservable: "cd.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "cd.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
}

async function runFlaggedDeclaration(
  makeDeclaration: (
    boundary: ReturnType<typeof contractFor>["boundary"],
  ) => Declaration,
): Promise<TransactionResult<Effects> | undefined> {
  const root = stateRoot();
  const state = stateAddonWithTestSeams({ root, report: "cd.pending" }, {});
  const holder: {
    boundary?: ReturnType<typeof contractFor>["boundary"];
    outcome?: TransactionResult<Effects>;
  } = {};
  const actor = changing({
    identity: "cd.open",
    route: ["open"],
    summary: "Run changing command.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_CD_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_CD_UNRESOLVED",
    stations: actorStations(),
    run: async (_input, context) => {
      const boundary = holder.boundary;
      if (!boundary) throw new Error("Boundary expected.");
      const outcome = await state.transaction(
        context.state,
        makeDeclaration(boundary),
        async (tx: EffectTransaction<Effects>) => {
          await tx.record(
            "doc.write",
            () => Promise.resolve(),
            () => Promise.resolve(true),
          );
        },
      );
      holder.outcome = outcome;
      if (outcome.kind !== "ran")
        return context.result(
          {
            commandIdentity: "cd.open",
            causeCode: "DOMAIN_CD_UNAVAILABLE",
          },
          { message: outcome.kind, data: null, effects: unchanged },
        );
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          { commandIdentity: "cd.open", causeCode: "DOMAIN_CD_UNAVAILABLE" },
          { message: "unchanged", data: null, effects: unchanged },
        );
      return context.result(
        {
          commandIdentity: "cd.open",
          causeCode:
            outcome.proof.transactionState === "completed"
              ? "SUCCESS_COMPLETED"
              : outcome.proof.transactionState === "partially-completed"
                ? "DOMAIN_CD_PARTIAL"
                : "DOMAIN_CD_UNKNOWN",
        },
        {
          message: outcome.proof.transactionState,
          data: null,
          transaction: outcome.proof,
        },
      );
    },
  });
  const contract = contractFor({
    cli: "cd",
    commands: [pendingCommand(), actor],
    causes: allCauses,
    state: state.descriptor,
    installedAddons: ["state"],
  });
  holder.boundary = contract.boundary;
  const ran = await runInProcess(contract, {
    emergencyRecord: state.emergencyRecord,
  })(["open"]);
  expect(ran.kind).toBe("envelope");
  return holder.outcome;
}

const keyScope = { resources: [{ resource: "doc", key: "alpha" }] } as const;

supportingTest(
  "SU27a.approval-runtime-aliased-in-facts-read-once: approval.runtime aliased in declaration.facts reads revalidateAndConsume at most once",
  async () => {
    let getterReads = 0;
    const runtime: ApprovalRuntime = {
      check: () => Promise.resolve(true),
      revalidateAndConsume: () => Promise.resolve({ consumed: true }),
    };
    Object.defineProperty(runtime, "revalidateAndConsume", {
      enumerable: true,
      get() {
        getterReads += 1;
        return () => Promise.resolve({ consumed: true });
      },
    });
    const outcome = await runFlaggedDeclaration((boundary) => ({
      command: "cd.open",
      scope: keyScope,
      supersedeUnresolved: true,
      facts: { runtimeRef: runtime },
      approval: {
        runtime,
        request: {
          authority: boundary.authority("operator"),
          resource: boundary.resource("doc"),
          resourceRevision: "v1",
          effects: ["doc.write"],
          preview: "preview-cd-runtime",
        },
      },
    }));
    expect(outcome?.kind).toBe("ran");
    expect(getterReads).toBe(1);
  },
);

supportingTest(
  "SU27b.approval-result-consumed-aliased-in-facts-read-once: revalidateAndConsume return value aliased in declaration.facts reads consumed once",
  async () => {
    let consumedReads = 0;
    const returned = { consumed: false };
    Object.defineProperty(returned, "consumed", {
      enumerable: true,
      get() {
        consumedReads += 1;
        return consumedReads === 1;
      },
    });
    const runtime: ApprovalRuntime = {
      check: () => Promise.resolve(true),
      revalidateAndConsume: () => Promise.resolve(returned),
    };
    const outcome = await runFlaggedDeclaration((boundary) => ({
      command: "cd.open",
      scope: keyScope,
      supersedeUnresolved: true,
      facts: { returnedRef: returned },
      approval: {
        runtime,
        request: {
          authority: boundary.authority("operator"),
          resource: boundary.resource("doc"),
          resourceRevision: "v1",
          effects: ["doc.write"],
          preview: "preview-cd-return",
        },
      },
    }));
    expect(outcome?.kind).toBe("ran");
    expect(consumedReads).toBe(1);
  },
);

supportingTest(
  "SU27c.approval-rejection-consumed-aliased-in-facts-read-once: revalidateAndConsume thrown error aliased in declaration.facts reads consumed once",
  async () => {
    let consumedReads = 0;
    const thrown = new Error("approval rejected");
    Object.defineProperty(thrown, "consumed", {
      enumerable: true,
      get() {
        consumedReads += 1;
        return consumedReads === 1;
      },
    });
    const runtime: ApprovalRuntime = {
      check: () => Promise.resolve(true),
      revalidateAndConsume: () => Promise.reject(thrown),
    };
    const outcome = await runFlaggedDeclaration((boundary) => ({
      command: "cd.open",
      scope: keyScope,
      supersedeUnresolved: true,
      facts: { thrownRef: thrown },
      approval: {
        runtime,
        request: {
          authority: boundary.authority("operator"),
          resource: boundary.resource("doc"),
          resourceRevision: "v1",
          effects: ["doc.write"],
          preview: "preview-cd-reject",
        },
      },
    }));
    expect(outcome?.kind).toBe("approval-lost");
    expect(consumedReads).toBe(1);
  },
);

supportingTest(
  "SU27d.approval-thenable-aliased-in-facts-read-once: custom thenable returned by revalidateAndConsume and aliased in declaration.facts reads then once",
  async () => {
    let thenReads = 0;
    const thenable: PromiseLike<{ readonly consumed: boolean }> = {
      then(onFulfilled) {
        return Promise.resolve({ consumed: true }).then(onFulfilled);
      },
    };
    Object.defineProperty(thenable, "then", {
      enumerable: true,
      get() {
        thenReads += 1;
        return (
          onFulfilled?: (value: { readonly consumed: boolean }) => unknown,
        ) => Promise.resolve({ consumed: true }).then(onFulfilled);
      },
    });
    const runtime: ApprovalRuntime = {
      check: () => Promise.resolve(true),
      revalidateAndConsume: () => Promise.resolve({ consumed: true }),
    };
    Object.defineProperty(runtime, "revalidateAndConsume", {
      enumerable: true,
      value: () => thenable,
    });
    const outcome = await runFlaggedDeclaration((boundary) => ({
      command: "cd.open",
      scope: keyScope,
      supersedeUnresolved: true,
      facts: { thenableRef: thenable },
      approval: {
        runtime,
        request: {
          authority: boundary.authority("operator"),
          resource: boundary.resource("doc"),
          resourceRevision: "v1",
          effects: ["doc.write"],
          preview: "preview-cd-thenable",
        },
      },
    }));
    expect(outcome?.kind).toBe("ran");
    expect(thenReads).toBe(1);
  },
);
