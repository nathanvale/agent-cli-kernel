import { afterEach, expect } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  ApprovalCapability,
  ApprovalRuntime,
  CauseTable,
  EffectTransaction,
  RunAddon,
} from "../../../kernel/src/kernel/index.ts";
import {
  approval,
  grantLocation,
} from "../../../kernel/src/addons/approval/index.ts";
import { stateAddonWithTestSeams } from "../../../kernel/src/addons/state/fixture.ts";
import type { Phase } from "../../../kernel/src/addons/state/fixture.ts";
import type {
  Declaration,
  TransactionResult,
} from "../../../kernel/src/addons/state/index.ts";
import { layout, readStore } from "../../../kernel/src/addons/state/store.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import { deferred } from "../lifecycle/recording-host.ts";
import { testFolder } from "../../support/test-folder.ts";
import { supportingTest } from "./harness.ts";

const causes = {
  DOMAIN_SW_LOCK_HELD: refusedHandoff,
  DOMAIN_SW_UNRESOLVED: refusedHandoff,
  DOMAIN_SW_UNAVAILABLE: refusedHandoff,
  DOMAIN_SW_PARTIAL: {
    ...refusedHandoff,
    outcome: "failed",
    transactionState: "partially-completed",
  },
  DOMAIN_SW_UNKNOWN: {
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
  const base = testFolder("sw-window-");
  createdFolders.push(base);
  const root = join(base, "state");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

const swHandoff = {
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
      commandIdentity: "sw.open",
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Completed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "sw.open:completed",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "sw.open",
      causeCode: "DOMAIN_SW_LOCK_HELD",
      trigger: "Held.",
      repairAction: "Retry.",
      guidance: swHandoff,
      independentObservable: "sw.open:held",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "sw.open",
      causeCode: "DOMAIN_SW_UNRESOLVED",
      trigger: "Unresolved.",
      repairAction: "Inspect.",
      guidance: swHandoff,
      independentObservable: "sw.open:unresolved",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "sw.open",
      causeCode: "DOMAIN_SW_UNAVAILABLE",
      trigger: "Unavailable.",
      repairAction: "Inspect.",
      guidance: swHandoff,
      independentObservable: "sw.open:unavailable",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "sw.open",
      causeCode: "DOMAIN_SW_PARTIAL",
      trigger: "Partial.",
      repairAction: "Inspect.",
      guidance: swHandoff,
      independentObservable: "sw.open:partial",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "sw.open",
      causeCode: "DOMAIN_SW_UNKNOWN",
      trigger: "Unknown.",
      repairAction: "Inspect.",
      guidance: swHandoff,
      independentObservable: "sw.open:unknown",
    }),
  ] as const;
}

function pendingCommand() {
  return command({
    identity: "sw.pending",
    route: ["pending"],
    summary: "Pending.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "sw.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: { next: { kind: "instruction", text: "Inspect." } },
        independentObservable: "sw.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "sw.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
}

function buildContract(
  state: ReturnType<typeof stateAddonWithTestSeams>,
  runTransaction: (
    boundary: ReturnType<typeof contractFor>["boundary"],
    stateCapability: Parameters<typeof state.transaction<Effects>>[0],
  ) => Promise<TransactionResult<Effects>>,
  approvalPreview?: string,
) {
  const holder: { boundary?: ReturnType<typeof contractFor>["boundary"] } = {};
  const withApproval = approvalPreview !== undefined;
  const actor = changing({
    identity: "sw.open",
    route: ["open"],
    summary: "Run changing command.",
    input: { ...emptyInput, deadlineSupported: true as const },
    capabilities: withApproval ? { approval: true as const } : {},
    ...(withApproval
      ? {
          approval: () => {
            const boundary = holder.boundary;
            if (!boundary) throw new Error("Boundary expected.");
            return {
              authority: boundary.authority("operator"),
              resource: boundary.resource("doc"),
              resourceRevision: "v1",
              effects: ["doc.write"],
              preview: approvalPreview,
            };
          },
        }
      : {}),
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_SW_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_SW_UNRESOLVED",
    stations: actorStations(),
    run: async (_input, context) => {
      const boundary = holder.boundary;
      if (!boundary) throw new Error("Boundary expected.");
      const outcome = await runTransaction(boundary, context.state);
      if (outcome.kind !== "ran")
        return context.result(
          {
            commandIdentity: "sw.open",
            causeCode: "DOMAIN_SW_UNAVAILABLE",
          },
          { message: outcome.kind, data: null, effects: unchanged },
        );
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          { commandIdentity: "sw.open", causeCode: "DOMAIN_SW_UNAVAILABLE" },
          { message: "unchanged", data: null, effects: unchanged },
        );
      return context.result(
        {
          commandIdentity: "sw.open",
          causeCode:
            outcome.proof.transactionState === "completed"
              ? "SUCCESS_COMPLETED"
              : outcome.proof.transactionState === "partially-completed"
                ? "DOMAIN_SW_PARTIAL"
                : "DOMAIN_SW_UNKNOWN",
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
    cli: "sw",
    commands: [pendingCommand(), actor],
    causes: allCauses,
    state: state.descriptor,
    installedAddons: withApproval ? ["state", "approval"] : ["state"],
  });
  holder.boundary = contract.boundary;
  return contract;
}

const keyScope = { resources: [{ resource: "doc", key: "alpha" }] } as const;

supportingTest(
  "SU26a.empty-targets-no-intent-after-deadline: flagged run with zero unresolved targets publishes no intent after deadline at admission-wait or staged",
  async () => {
    for (const stopPhase of ["admission-wait", "staged"] as const) {
      const root = stateRoot();
      const gate = deferred();
      const settled = deferred();
      const state = stateAddonWithTestSeams(
        { root, report: "sw.pending" },
        {
          phase: async (name: Phase) => {
            if (name === stopPhase) await gate.promise;
          },
        },
      );
      const contract = buildContract(state, (_boundary, cap) =>
        state
          .transaction(
            cap,
            { command: "sw.open", scope: keyScope, supersedeUnresolved: true },
            async (tx: EffectTransaction<Effects>) => {
              await tx.record(
                "doc.write",
                () => Promise.resolve(),
                () => Promise.resolve(true),
              );
            },
          )
          .finally(() => settled.resolve()),
      );
      try {
        const ran = await runInProcess(contract, {
          emergencyRecord: state.emergencyRecord,
        })(["open", "--deadline-ms", "20"]);
        expect(ran.kind).toBe("envelope");
        if (ran.kind === "envelope")
          expect(ran.envelope.result.causeCode).toBe("DOMAIN_DEADLINE_UNKNOWN");
      } finally {
        gate.resolve();
      }
      await settled.promise;
      expect({
        stopPhase,
        operationsCount: readdirSync(layout(root).operations).length,
      }).toEqual({ stopPhase, operationsCount: 0 });
    }
  },
  15_000,
);

supportingTest(
  "SU26b.approval-not-consumed-after-deadline: one-time approval grant is not consumed on disk after deadline fires before consumeOnce",
  async () => {
    const root = stateRoot();
    const base = join(root, "..");
    const grantsDir = join(base, "grants");
    const consumedDir = join(base, "consumed");
    mkdirSync(grantsDir, { recursive: true, mode: 0o700 });
    mkdirSync(consumedDir, { recursive: true, mode: 0o700 });
    const store = { grants: grantsDir, consumed: consumedDir };
    const preview = "preview-dl-consume";
    const previewControl = "preview-dl-control";
    for (const p of [previewControl, preview]) {
      writeFileSync(
        grantLocation(store, p),
        JSON.stringify({
          format: "contract3.approval-grant",
          version: 1,
          operation: "sw.open",
          preview: p,
          authority: "operator",
          resource: "doc",
          resourceRevision: "v1",
          effects: ["doc.write"],
          expiresAt: Date.now() + 60_000,
        }),
        { mode: 0o600 },
      );
    }

    const makeApprovalAddon = (
      descriptor: ReturnType<typeof stateAddonWithTestSeams>["descriptor"],
      box: { runtime?: ApprovalRuntime },
    ): RunAddon<ApprovalCapability> => ({
      attach(run) {
        const instance = approval({
          operation: "sw.open",
          runId: run.runId,
          store,
        });
        box.runtime = instance.runtime(descriptor);
        return {
          capability: instance.capability,
          settle: () => Promise.resolve(true),
          killNow: () => {},
        };
      },
    });

    const controlState = stateAddonWithTestSeams(
      { root, report: "sw.pending" },
      {},
    );
    const controlBox: { runtime?: ApprovalRuntime } = {};
    let controlOutcome: TransactionResult<Effects> | undefined;
    const controlContract = buildContract(
      controlState,
      (boundary, cap) => {
        if (!controlBox.runtime) throw new Error("Approval runtime expected.");
        return controlState
          .transaction(
            cap,
            {
              command: "sw.open",
              scope: keyScope,
              supersedeUnresolved: true,
              approval: {
                runtime: controlBox.runtime,
                request: {
                  authority: boundary.authority("operator"),
                  resource: boundary.resource("doc"),
                  resourceRevision: "v1",
                  effects: ["doc.write"],
                  preview: previewControl,
                },
              },
            },
            async (tx) => {
              await tx.record(
                "doc.write",
                () => Promise.resolve(),
                () => Promise.resolve(true),
              );
            },
          )
          .then((result) => {
            controlOutcome = result;
            return result;
          });
      },
      previewControl,
    );
    const controlRan = await runInProcess(controlContract, {
      emergencyRecord: controlState.emergencyRecord,
      addons: {
        approval: makeApprovalAddon(controlState.descriptor, controlBox),
      },
    })(["open"]);
    expect(controlRan.kind).toBe("envelope");
    expect(controlOutcome?.kind).toBe("ran");
    expect(readdirSync(consumedDir).length).toBe(1);

    const gate = deferred();
    const settled = deferred();
    const state = stateAddonWithTestSeams(
      { root, report: "sw.pending" },
      {
        phase: async (name: Phase) => {
          if (name === "admission-wait") await gate.promise;
        },
      },
    );
    const runBox: { runtime?: ApprovalRuntime } = {};
    const contract = buildContract(
      state,
      (boundary, cap) => {
        if (!runBox.runtime) throw new Error("Approval runtime expected.");
        const decl: Declaration = {
          command: "sw.open",
          scope: keyScope,
          supersedeUnresolved: true,
          approval: {
            runtime: runBox.runtime,
            request: {
              authority: boundary.authority("operator"),
              resource: boundary.resource("doc"),
              resourceRevision: "v1",
              effects: ["doc.write"],
              preview,
            },
          },
        };
        return state
          .transaction(cap, decl, async (tx) => {
            await tx.record(
              "doc.write",
              () => Promise.resolve(),
              () => Promise.resolve(true),
            );
          })
          .finally(() => settled.resolve());
      },
      preview,
    );
    try {
      const ran = await runInProcess(contract, {
        emergencyRecord: state.emergencyRecord,
        addons: { approval: makeApprovalAddon(state.descriptor, runBox) },
      })(["open", "--deadline-ms", "20"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind === "envelope")
        expect(ran.envelope.result.causeCode).toBe("DOMAIN_DEADLINE_UNKNOWN");
    } finally {
      gate.resolve();
    }
    await settled.promise;
    expect(readdirSync(consumedDir).length).toBe(1);
  },
  15_000,
);

supportingTest(
  "SU26c.effect-started-not-written-after-deadline: record() called after deadline rejects without appending effect-started",
  async () => {
    const root = stateRoot();
    const gate = deferred();
    const settled = deferred();
    let recordError = "none";
    const state = stateAddonWithTestSeams({ root, report: "sw.pending" }, {});
    const contract = buildContract(state, (_boundary, cap) =>
      state
        .transaction(
          cap,
          { command: "sw.open", scope: keyScope, supersedeUnresolved: true },
          async (tx) => {
            await gate.promise;
            try {
              await tx.record(
                "doc.write",
                () => Promise.resolve(),
                () => Promise.resolve(true),
              );
            } catch (error) {
              recordError =
                error instanceof Error ? error.message : String(error);
            }
          },
        )
        .finally(() => settled.resolve()),
    );
    try {
      const ran = await runInProcess(contract, {
        emergencyRecord: state.emergencyRecord,
      })(["open", "--deadline-ms", "20"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind === "envelope")
        expect(ran.envelope.result.causeCode).toBe("DOMAIN_DEADLINE_UNKNOWN");
    } finally {
      gate.resolve();
    }
    await settled.promise;
    expect(recordError).toContain("deadline");
    const store = readStore(layout(root));
    expect(store.ok).toBe(true);
    if (!store.ok) return;
    const allEvents = store.operations.flatMap((op) =>
      op.events.map((e) => e.kind),
    );
    expect(allEvents).not.toContain("effect-started");
  },
  15_000,
);

supportingTest(
  "SU26d.delegate-admitted-not-written-after-deadline: admitStart() called after deadline rejects without appending delegate-admitted",
  async () => {
    const root = stateRoot();
    const gate = deferred();
    const settled = deferred();
    let admitError = "none";
    let startCalled = 0;
    const state = stateAddonWithTestSeams({ root, report: "sw.pending" }, {});
    const contract = buildContract(state, (_boundary, cap) =>
      state
        .transaction(
          cap,
          { command: "sw.open", scope: keyScope, supersedeUnresolved: true },
          async (tx) => {
            await tx.record(
              "doc.write",
              async (recorded) => {
                await gate.promise;
                try {
                  await recorded.admitStart(
                    recorded.runId,
                    recorded.effect,
                    () => {
                      startCalled += 1;
                      return Promise.resolve("started");
                    },
                  );
                } catch (error) {
                  admitError =
                    error instanceof Error ? error.message : String(error);
                }
              },
              () => Promise.resolve(true),
            );
          },
        )
        .finally(() => settled.resolve()),
    );
    try {
      const ran = await runInProcess(contract, {
        emergencyRecord: state.emergencyRecord,
      })(["open", "--deadline-ms", "20"]);
      expect(ran.kind).toBe("envelope");
      if (ran.kind === "envelope")
        expect(ran.envelope.result.causeCode).toBe("DOMAIN_DEADLINE_UNKNOWN");
    } finally {
      gate.resolve();
    }
    await settled.promise;
    expect(startCalled).toBe(0);
    expect(admitError).toContain("deadline");
    const store = readStore(layout(root));
    expect(store.ok).toBe(true);
    if (!store.ok) return;
    const allEvents = store.operations.flatMap((op) =>
      op.events.map((e) => e.kind),
    );
    expect(allEvents).not.toContain("delegate-admitted");
  },
  15_000,
);
