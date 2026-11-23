import { afterEach, expect } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
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
  Envelope,
  ProgramsCapability,
  RunAddon,
} from "../../../kernel/src/kernel/index.ts";
import {
  stateAddon,
  supersededQualification,
  supersedeFilesystemReason,
} from "../../../kernel/src/addons/state/index.ts";
import type {
  Declaration,
  PublishedOperation,
  ScopeDeclaration,
  TransactionResult,
} from "../../../kernel/src/addons/state/index.ts";
import { stateAddonWithTestSeams } from "../../../kernel/src/addons/state/fixture.ts";
import type {
  CapabilityQualificationRow,
  FactOverrides,
  Phase,
} from "../../../kernel/src/addons/state/fixture.ts";
import { movedStateRoot } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import { resolveCoordination } from "../../../kernel/src/addons/state/coordination.ts";
import type { CoordinationRoute } from "../../../kernel/src/addons/state/coordination.ts";
import { encodeRecord } from "../../../kernel/src/addons/state/framing.ts";
import { stoppedOwnerProblem } from "../../../kernel/src/addons/state/install.ts";
import {
  appendDelegateStart,
  appendStartedEvent,
  layout,
  readCase,
  unflaggedWriteGate,
} from "../../../kernel/src/addons/state/store.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import { testFolder } from "../../support/test-folder.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { readOperations, supportingTest } from "./harness.ts";

const causes = {
  DOMAIN_SU_LOCK_HELD: refusedHandoff,
  DOMAIN_SU_UNRESOLVED: refusedHandoff,
  DOMAIN_SU_UNAVAILABLE: refusedHandoff,
  DOMAIN_SU_PARTIAL: {
    ...refusedHandoff,
    outcome: "failed",
    transactionState: "partially-completed",
  },
  DOMAIN_SU_UNKNOWN: {
    ...refusedHandoff,
    outcome: "failed",
    transactionState: "unknown",
  },
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };
const pendingStep = {
  kind: "command",
  command: "su.pending",
  args: [],
} as const;
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Manual check required.",
    inspect: [pendingStep],
  },
} as const;

type Effects = "doc.write" | "editor.launch";
const defaultEffects: readonly [Effects, ...Effects[]] = [
  "doc.write",
  "editor.launch",
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function stateRoot(prefix = "c3-supersede-"): string {
  const folder = testFolder(prefix);
  roots.push(folder);
  return join(folder, "state");
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type RunOptions = {
  readonly root: string;
  readonly command?: "su.open" | "su.other";
  readonly scope?: ScopeDeclaration;
  readonly supersedeUnresolved?: boolean;
  readonly phase?: (name: Phase) => Promise<void>;
  readonly coordination?: CoordinationRoute;
  readonly candidateRow?: CapabilityQualificationRow;
  readonly factOverrides?: FactOverrides;
  readonly work?: (
    transaction: EffectTransaction<Effects>,
    published: PublishedOperation,
  ) => Promise<void>;
};

function makeStateForHost(options: RunOptions): ReturnType<typeof stateAddon> {
  const stateOptions = { root: options.root, report: "su.pending" };
  const phase = options.phase;
  const coordination = options.coordination;
  if (options.candidateRow !== undefined)
    return stateAddonWithTestSeams(stateOptions, {
      fixtureLabel: "su-test",
      candidateRow: options.candidateRow,
      ...(options.factOverrides === undefined
        ? {}
        : { factOverrides: options.factOverrides }),
      ...(phase === undefined ? {} : { phase }),
      ...(coordination === undefined ? {} : { coordination }),
    });
  if (phase !== undefined || coordination !== undefined)
    return stateAddonWithTestSeams(stateOptions, {
      ...(phase === undefined ? {} : { phase }),
      ...(coordination === undefined ? {} : { coordination }),
    });
  return stateAddon(stateOptions);
}

async function runHost(options: RunOptions): Promise<{
  readonly state: ReturnType<typeof stateAddon>;
  readonly outcome: TransactionResult<Effects>;
  readonly published: PublishedOperation | undefined;
  readonly envelope: Envelope;
  readonly validate: (value: unknown) => Promise<{ readonly ok: boolean }>;
  readonly runPending: () => Promise<Envelope>;
  readonly runId: string;
  readonly causeCode: string;
}> {
  const commandId = options.command ?? "su.open";
  const state = makeStateForHost(options);
  let captured: TransactionResult<Effects> | undefined;
  let published: PublishedOperation | undefined;
  const scope: ScopeDeclaration = options.scope ?? {
    resources: [{ resource: "doc", key: "alpha" }],
  };
  const work =
    options.work ??
    (async (transaction: EffectTransaction<Effects>) => {
      for (const effect of defaultEffects)
        await transaction.record(
          effect,
          () => Promise.resolve(),
          () => Promise.resolve(true),
        );
    });
  const pending = command({
    identity: "su.pending",
    route: ["pending"],
    summary: "Report unfinished runs.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "su.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: {
          next: { kind: "instruction", text: "Inspect unfinished cases." },
        },
        independentObservable: "su.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "su.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
  const actor = changing({
    identity: commandId,
    route: [commandId === "su.open" ? "open" : "other"],
    summary: "Run a changing command.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_SU_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_SU_UNRESOLVED",
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: commandId,
        causeCode: "SUCCESS_COMPLETED",
        trigger: "Completed.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${commandId}:done`,
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: commandId,
        causeCode: "DOMAIN_SU_LOCK_HELD",
        trigger: "Held.",
        repairAction: "Wait for the live run.",
        guidance: handoff,
        independentObservable: `${commandId}:held`,
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: commandId,
        causeCode: "DOMAIN_SU_UNRESOLVED",
        trigger: "Unresolved.",
        repairAction: "Inspect unfinished cases.",
        guidance: handoff,
        independentObservable: `${commandId}:unresolved`,
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: commandId,
        causeCode: "DOMAIN_SU_UNAVAILABLE",
        trigger: "Unavailable.",
        repairAction: "Inspect state.",
        guidance: handoff,
        independentObservable: `${commandId}:unavailable`,
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: commandId,
        causeCode: "DOMAIN_SU_PARTIAL",
        trigger: "Partial.",
        repairAction: "Inspect unfinished cases.",
        guidance: handoff,
        independentObservable: `${commandId}:partial`,
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: commandId,
        causeCode: "DOMAIN_SU_UNKNOWN",
        trigger: "Unknown.",
        repairAction: "Inspect unfinished cases.",
        guidance: handoff,
        independentObservable: `${commandId}:unknown`,
      }),
    ],
    run: async (_input, context) => {
      const outcome = await state.transaction(
        context.state,
        {
          command: commandId,
          scope,
          ...(options.supersedeUnresolved === undefined
            ? {}
            : { supersedeUnresolved: options.supersedeUnresolved }),
        },
        (transaction, info) => {
          published = info;
          return work(transaction, info);
        },
      );
      captured = outcome;
      if (outcome.kind !== "ran") {
        const causeCode =
          outcome.kind === "held-lock"
            ? "DOMAIN_SU_LOCK_HELD"
            : outcome.kind === "unresolved-case"
              ? "DOMAIN_SU_UNRESOLVED"
              : "DOMAIN_SU_UNAVAILABLE";
        return context.result(
          { commandIdentity: commandId, causeCode },
          {
            message: outcome.kind,
            data: null,
            effects: unchanged,
          },
        );
      }
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          { commandIdentity: commandId, causeCode: "DOMAIN_SU_UNAVAILABLE" },
          { message: "unchanged", data: null, effects: unchanged },
        );
      const causeCode =
        outcome.proof.transactionState === "completed"
          ? "SUCCESS_COMPLETED"
          : outcome.proof.transactionState === "partially-completed"
            ? "DOMAIN_SU_PARTIAL"
            : "DOMAIN_SU_UNKNOWN";
      return context.result(
        { commandIdentity: commandId, causeCode },
        {
          message: outcome.proof.transactionState,
          data: null,
          transaction: outcome.proof,
        },
      );
    },
  });
  const contract = contractFor({
    cli: "su",
    commands: [pending, actor],
    causes: allCauses,
    state: state.descriptor,
    installedAddons: ["state"],
  });
  const run = runInProcess(contract, {
    emergencyRecord: state.emergencyRecord,
  });
  const ran = await run([commandId === "su.open" ? "open" : "other"]);
  if (ran.kind !== "envelope" || !captured)
    throw new Error(`Expected envelope and transaction outcome.`);
  return {
    state,
    outcome: captured,
    published,
    envelope: ran.envelope,
    validate: (value) => contract.validate(value),
    runPending: async () => {
      const pendingRun = await run(["pending"]);
      if (pendingRun.kind !== "envelope")
        throw new Error("Expected pending envelope.");
      return pendingRun.envelope;
    },
    runId: ran.runId,
    causeCode: ran.envelope.result.causeCode,
  };
}

async function seedUnresolved(
  root: string,
  options: {
    readonly command?: "su.open" | "su.other";
    readonly scope?: ScopeDeclaration;
  } = {},
): Promise<string> {
  const seeded = await runHost({
    root,
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    work: async (transaction) => {
      await transaction.record(
        "doc.write",
        () => Promise.resolve(),
        () => Promise.resolve(false),
      );
    },
  });
  expect(seeded.outcome.kind).toBe("ran");
  if (seeded.outcome.kind !== "ran") throw new Error("Expected ran outcome.");
  return seeded.outcome.operationId;
}

function writePriorClosure(
  root: string,
  operationId: string,
  revision: string,
): Uint8Array {
  const bytes = encodeRecord("closure", {
    operationId,
    closureId: "prior-c1",
    disposition: "completed",
    reason: "closed independently",
    evidence: [
      { effect: "doc.write", observation: "present" },
      { effect: "editor.launch", observation: "present" },
    ],
    authority: null,
    journalRevision: revision,
    qualification: "fixture:external",
    recoveryRunId: "prior-run",
    settledAt: Date.now(),
  });
  writeFileSync(join(root, "operations", operationId, "closure"), bytes);
  return bytes;
}

supportingTest(
  "SU01.flag-absent-refuses-unresolved-case: flag absent refuses unresolved-case for the same command and writes no closure",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const second = await runHost({ root });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(second.causeCode).toBe("DOMAIN_SU_UNRESOLVED");
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
    expect(readOperations(root, "settled")).toHaveLength(0);
    expect(second.state.report()).toMatchObject({
      ok: true,
      unfinished: [{ operationId: oldId }],
    });
  },
);

supportingTest(
  "SU02.live-owner-lease-refuses-held-lock: flag set refuses held-lock when a live run holds the prior case owner lease on known or unknown scope and writes no closure",
  async () => {
    for (const scope of [
      { resources: [{ resource: "doc", key: "alpha" }] },
      { unknown: true as const },
    ]) {
      const root = stateRoot();
      const entered = deferred();
      const release = deferred();
      const first = runHost({
        root,
        scope,
        work: async (transaction) => {
          await transaction.record(
            "doc.write",
            async () => {
              entered.resolve();
              await release.promise;
            },
            () => Promise.resolve(true),
          );
          await transaction.record(
            "editor.launch",
            () => Promise.resolve(),
            () => Promise.resolve(true),
          );
        },
      });
      await entered.promise;
      const operations = readOperations(root);
      expect(operations).toHaveLength(1);
      const liveId = operations[0]?.id;
      if (!liveId) throw new Error("Expected live operation.");
      const contender = await runHost({
        root,
        scope,
        supersedeUnresolved: true,
      });
      expect(contender.outcome).toMatchObject({
        kind: "held-lock",
        operationId: liveId,
      });
      expect(contender.causeCode).toBe("DOMAIN_SU_LOCK_HELD");
      expect(existsSync(join(root, "operations", liveId, "closure"))).toBe(
        false,
      );
      release.resolve();
      const finished = await first;
      expect(finished.outcome.kind).toBe("ran");
      expect(finished.causeCode).toBe("SUCCESS_COMPLETED");
    }
  },
);

supportingTest(
  "SU02b.lease-busy-on-acquire-refuses-held-lock: flag set refuses held-lock when the prior case owner lease becomes busy right before supersede acquires it",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const route = resolveCoordination();
    if (!route.available) throw new Error("Coordination expected.");
    let releaseHolder: (() => void) | undefined;
    try {
      const second = await runHost({
        root,
        supersedeUnresolved: true,
        phase: (name) => {
          if (name === "closure-read") {
            const attempt = route.tryLock(
              join(root, "operations", oldId, "owner.lease"),
              false,
            );
            if (attempt.kind !== "held")
              throw new Error(`Expected held lease, got ${attempt.kind}.`);
            releaseHolder = attempt.release;
          }
          return Promise.resolve();
        },
      });
      expect(second.outcome).toMatchObject({
        kind: "held-lock",
        operationId: oldId,
      });
      expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(
        false,
      );
    } finally {
      releaseHolder?.();
    }
  },
);

supportingTest(
  "SU02c.lease-unreadable-refuses-unavailable: flag set refuses unavailable lease-unreadable when the prior case owner lease cannot be locked",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      phase: (name) => {
        if (name === "closure-read")
          rmSync(join(root, "operations", oldId, "owner.lease"));
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unavailable",
      reason: "lease-unreadable",
    });
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
  },
);

supportingTest(
  "SU03.different-command-refuses-unresolved-case: flag set refuses unresolved-case when the prior case belongs to a different command identity on the same scope",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root, { command: "su.other" });
    const second = await runHost({
      root,
      command: "su.open",
      supersedeUnresolved: true,
    });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(second.causeCode).toBe("DOMAIN_SU_UNRESOLVED");
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
    expect(readOperations(root, "settled")).toHaveLength(0);
  },
);

supportingTest(
  "SU04.record-hidden-in-torn-tail-refuses: flag set refuses unresolved-case when the prior case has a record hidden in a torn tail and writes no closure",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const hidden = encodeRecord("delegate-admitted", {
      effect: "editor.launch",
    });
    appendFileSync(
      join(root, "operations", oldId, "events"),
      Buffer.concat([Buffer.from("C3S1 effect-started "), Buffer.from(hidden)]),
    );
    const second = await runHost({ root, supersedeUnresolved: true });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(second.causeCode).toBe("DOMAIN_SU_UNRESOLVED");
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
  },
);

supportingTest(
  "SU05.damaged-closure-refuses: flag set refuses unresolved-case when the prior case has a damaged closure and writes no closure",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const closurePath = join(root, "operations", oldId, "closure");
    writeFileSync(closurePath, "damaged-closure-bytes\n");
    const phases: Phase[] = [];
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      phase: (name) => {
        phases.push(name);
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(second.causeCode).toBe("DOMAIN_SU_UNRESOLVED");
    expect(phases).not.toContain("closure-staged");
    expect(readFileSync(closurePath, "utf8")).toBe("damaged-closure-bytes\n");
    expect(readOperations(root, "settled")).toHaveLength(0);
  },
);

supportingTest(
  "SU06.free-lease-heals-and-moves-to-settled: flag set closes a free-lease unresolved case with outcome-unknown, lets the new run proceed, and moves the old case to settled as closed",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    appendDelegateStart(
      unflaggedWriteGate(),
      join(root, "operations", oldId, "events"),
      "editor.launch",
      "same-boot-id",
    );
    const before = await stateAddon({
      root,
      report: "su.pending",
    }).history(oldId);
    if (!before.ok) throw new Error("Expected history.");
    const priorRevision = before.history.journal.revision;

    const healed = await runHost({ root, supersedeUnresolved: true });
    expect(healed.outcome.kind).toBe("ran");
    expect(healed.causeCode).toBe("SUCCESS_COMPLETED");
    if (healed.outcome.kind !== "ran") throw new Error("Expected ran outcome.");
    expect(healed.outcome.operationId).not.toBe(oldId);

    expect(existsSync(join(root, "operations", oldId))).toBe(false);
    expect(existsSync(join(root, "settled", oldId, "closure"))).toBe(true);
    const settled = readOperations(root, "settled");
    const closedRecord = settled.find((entry) => entry.id === oldId);
    expect(closedRecord).toBeDefined();
    const closurePayload = closedRecord?.closure?.records[0]?.payload;
    expect(closurePayload).toMatchObject({
      operationId: oldId,
      disposition: "outcome-unknown",
      authority: null,
      journalRevision: priorRevision,
      qualification: supersededQualification,
      recoveryRunId: healed.runId,
      evidence: [],
    });
    const history = await healed.state.history(oldId);
    expect(history).toMatchObject({
      ok: true,
      history: {
        status: "closed",
        closureDamaged: false,
        closure: {
          disposition: "outcome-unknown",
          qualification: supersededQualification,
          journalRevision: priorRevision,
          evidence: [],
        },
      },
    });
    expect(healed.state.report()).toEqual({ ok: true, unfinished: [] });
  },
);

supportingTest(
  "SU07a.case-closed-between-scan-and-reread-refuses: flag set refuses when the case is no longer unresolved between scan and re-read and writes no second closure",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const before = await stateAddon({
      root,
      report: "su.pending",
    }).history(oldId);
    if (!before.ok) throw new Error("Expected history.");
    const phases: Phase[] = [];
    let priorBytes: Uint8Array | undefined;
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      phase: (name) => {
        phases.push(name);
        if (name === "closure-read")
          priorBytes = writePriorClosure(
            root,
            oldId,
            before.history.journal.revision,
          );
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(phases).not.toContain("closure-staged");
    expect(priorBytes).toBeDefined();
    expect(readFileSync(join(root, "operations", oldId, "closure"))).toEqual(
      Buffer.from(priorBytes ?? new Uint8Array()),
    );
  },
);

supportingTest(
  "SU07b.case-revision-changed-between-scan-and-reread-refuses: flag set refuses when the case revision changes between scan and re-read while still unresolved",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const phases: Phase[] = [];
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      phase: (name) => {
        phases.push(name);
        if (name === "closure-read")
          appendStartedEvent(
            unflaggedWriteGate(),
            join(root, "operations", oldId, "events"),
            "effect-started",
            { effect: "editor.launch" },
          );
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(phases).not.toContain("closure-staged");
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
  },
);

supportingTest(
  "SU07c.case-damaged-between-scan-and-reread-refuses: flag set refuses when closure damage appears between scan and re-read",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const closurePath = join(root, "operations", oldId, "closure");
    const phases: Phase[] = [];
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      phase: (name) => {
        phases.push(name);
        if (name === "closure-read")
          writeFileSync(closurePath, "damaged-mid-flight\n");
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(phases).not.toContain("closure-staged");
    expect(readFileSync(closurePath, "utf8")).toBe("damaged-mid-flight\n");
  },
);

supportingTest(
  "SU07d.case-corrupt-between-scan-and-reread-refuses: flag set refuses unavailable store-corrupt when the case becomes corrupt between scan and re-read",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      phase: (name) => {
        if (name === "closure-read")
          writeFileSync(
            join(root, "operations", oldId, "intent"),
            "corrupt-intent\n",
          );
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unavailable",
      reason: "store-corrupt",
    });
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
  },
);

supportingTest(
  "SU07e.closure-exists-at-publish-refuses: flag set refuses unresolved-case when a closure appears right before link publish",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const before = await stateAddon({
      root,
      report: "su.pending",
    }).history(oldId);
    if (!before.ok) throw new Error("Expected history.");
    let priorBytes: Uint8Array | undefined;
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      phase: (name) => {
        if (name === "closure-staged")
          priorBytes = writePriorClosure(
            root,
            oldId,
            before.history.journal.revision,
          );
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(priorBytes).toBeDefined();
    expect(readFileSync(join(root, "operations", oldId, "closure"))).toEqual(
      Buffer.from(priorBytes ?? new Uint8Array()),
    );
  },
);

supportingTest(
  "SU08.concurrent-heals-write-one-closure: two runs trying to heal the same case at once produce exactly one closure",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const atRead = deferred();
    const releaseRead = deferred();
    const inWork = deferred();
    const releaseWork = deferred();

    const first = runHost({
      root,
      supersedeUnresolved: true,
      phase: async (name) => {
        if (name === "closure-read") {
          atRead.resolve();
          await releaseRead.promise;
        }
      },
      work: async (transaction) => {
        inWork.resolve();
        await releaseWork.promise;
        for (const effect of defaultEffects)
          await transaction.record(
            effect,
            () => Promise.resolve(),
            () => Promise.resolve(true),
          );
      },
    });
    await atRead.promise;
    const second = runHost({
      root,
      supersedeUnresolved: true,
    });
    releaseRead.resolve();
    await inWork.promise;
    const secondResult = await second;
    releaseWork.resolve();
    const firstResult = await first;

    expect(firstResult.outcome.kind).toBe("ran");
    expect(firstResult.causeCode).toBe("SUCCESS_COMPLETED");
    expect(["held-lock", "busy"]).toContain(secondResult.outcome.kind);
    const closurePath = join(root, "settled", oldId, "closure");
    expect(existsSync(closurePath)).toBe(true);
    const closureBytes = readFileSync(closurePath);
    const settled = readOperations(root, "settled").find(
      (entry) => entry.id === oldId,
    );
    expect(settled?.closure?.records).toHaveLength(1);
    expect(settled?.closure?.records[0]?.payload).toMatchObject({
      operationId: oldId,
      disposition: "outcome-unknown",
      qualification: supersededQualification,
      recoveryRunId: firstResult.runId,
    });

    const third = await runHost({ root, supersedeUnresolved: true });
    expect(third.outcome.kind).toBe("ran");
    expect(readFileSync(closurePath)).toEqual(closureBytes);
  },
);

supportingTest(
  "SU09.non-conflicting-scope-untouched: flag set leaves a prior unresolved case on a non-conflicting scope untouched",
  async () => {
    const root = stateRoot();
    const marsId = await seedUnresolved(root, {
      scope: { resources: [{ resource: "doc", key: "mars" }] },
    });
    const earthRun = await runHost({
      root,
      scope: { resources: [{ resource: "doc", key: "earth" }] },
      supersedeUnresolved: true,
    });
    expect(earthRun.outcome.kind).toBe("ran");
    expect(earthRun.causeCode).toBe("SUCCESS_COMPLETED");
    expect(existsSync(join(root, "operations", marsId))).toBe(true);
    expect(existsSync(join(root, "operations", marsId, "closure"))).toBe(false);
    expect(existsSync(join(root, "settled", marsId))).toBe(false);
    expect(earthRun.state.report()).toMatchObject({
      ok: true,
      unfinished: [{ operationId: marsId }],
    });
  },
);

function testCandidateRow(
  filesystemType = 0x9123683e,
): CapabilityQualificationRow {
  const route = resolveCoordination();
  return {
    id: "su-candidate",
    os: process.platform,
    majorRelease: "7",
    observedRelease: "7.0.0",
    filesystem: { name: "test-local", type: filesystemType },
    primitive: route.available ? route.route : "unavailable",
    bootIdentitySource: "/proc/sys/kernel/random/boot_id",
    processIdentity: "boot identity only",
    namespace: "test",
    delegatedWriters: "same-boot refuses",
    failureCases: [movedStateRoot],
    evidence: {
      record: "none",
      review: { session: "none", countersignature: "none", date: "none" },
    },
  };
}

async function runCrashChild(
  root: string,
  crashPhase: "staged" | "closure-staged",
): Promise<number> {
  const script = `
    import { changing, command, commonCauses, contractFor, runInProcess, station } from "./kernel/src/kernel/index.ts";
    import { stateAddonWithTestSeams } from "./kernel/src/addons/state/fixture.ts";
    import { emptyInput, refusedHandoff, stationWords, unchanged } from "./tests/kernel/kernel-repair/shapes.ts";
    const [root, crashPhase] = process.argv.slice(1);
    const causes = { ...commonCauses, DOMAIN_SU_LOCK_HELD: refusedHandoff, DOMAIN_SU_UNRESOLVED: refusedHandoff, DOMAIN_SU_UNAVAILABLE: refusedHandoff };
    const pendingStep = { kind: "command", command: "su.pending", args: [] };
    const handoff = { handoff: { owner: "operator", reason: "Check.", inspect: [pendingStep] } };
    const state = stateAddonWithTestSeams({ root, report: "su.pending" }, {
      phase: (name) => {
        if (name === crashPhase) process.exit(99);
        return Promise.resolve();
      },
    });
    const pending = command({
      identity: "su.pending", route: ["pending"], summary: "Pending.", input: emptyInput, capabilities: {},
      stations: [station(causes, { ...stationWords, commandIdentity: "su.pending", causeCode: "SUCCESS_UNCHANGED", trigger: "Read.", repairAction: null, guidance: { next: { kind: "instruction", text: "Inspect." } }, independentObservable: "su.pending:read" })],
      run: (_i, ctx) => ctx.result({ commandIdentity: "su.pending", causeCode: "SUCCESS_UNCHANGED" }, { message: "Read.", data: null, effects: unchanged }),
    });
    const actor = changing({
      identity: "su.open", route: ["open"], summary: "Open.", input: emptyInput, capabilities: {},
      effectClass: "repository-local", effects: ["doc.write", "editor.launch"],
      ifNoResult: state.descriptor.ifNoResult, heldLockCause: "DOMAIN_SU_LOCK_HELD", unresolvedCaseCause: "DOMAIN_SU_UNRESOLVED",
      stations: [
        station(causes, { ...stationWords, commandIdentity: "su.open", causeCode: "SUCCESS_COMPLETED", trigger: "Done.", repairAction: null, guidance: { next: { kind: "done" } }, independentObservable: "su.open:done" }),
        station(causes, { ...stationWords, commandIdentity: "su.open", causeCode: "DOMAIN_SU_LOCK_HELD", trigger: "Held.", repairAction: "Wait.", guidance: handoff, independentObservable: "su.open:held" }),
        station(causes, { ...stationWords, commandIdentity: "su.open", causeCode: "DOMAIN_SU_UNRESOLVED", trigger: "Unresolved.", repairAction: "Check.", guidance: handoff, independentObservable: "su.open:unresolved" }),
        station(causes, { ...stationWords, commandIdentity: "su.open", causeCode: "DOMAIN_SU_UNAVAILABLE", trigger: "Unavailable.", repairAction: "Check.", guidance: handoff, independentObservable: "su.open:unavailable" }),
      ],
      run: async (_i, ctx) => {
        const outcome = await state.transaction(ctx.state, {
          command: "su.open",
          scope: { resources: [{ resource: "doc", key: "alpha" }] },
          supersedeUnresolved: true,
        }, async (tx) => {
          await tx.record("doc.write", () => Promise.resolve(), () => Promise.resolve(true));
          await tx.record("editor.launch", () => Promise.resolve(), () => Promise.resolve(true));
        });
        if (outcome.kind !== "ran") return ctx.result({ commandIdentity: "su.open", causeCode: "DOMAIN_SU_UNAVAILABLE" }, { message: outcome.kind, data: null, effects: unchanged });
        return ctx.result({ commandIdentity: "su.open", causeCode: "SUCCESS_COMPLETED" }, { message: "ok", data: null, transaction: outcome.proof });
      },
    });
    const contract = contractFor({ cli: "su", commands: [pending, actor], causes, state: state.descriptor, installedAddons: ["state"] });
    await runInProcess(contract, { emergencyRecord: state.emergencyRecord })(["open"]);
  `;
  const ran = await spawnBounded(
    [process.execPath, "--no-install", "-e", script, root, crashPhase],
    { cwd: process.cwd(), boundMilliseconds: 10_000 },
  );
  return ran.exit;
}

supportingTest(
  "SU10a.same-boot-delegate-flagged-heals: flagged path clears a dead case even when a same-boot delegate-admitted record exists",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    appendDelegateStart(
      unflaggedWriteGate(),
      join(root, "operations", oldId, "events"),
      "editor.launch",
      "boot-current",
    );
    const read = readCase(layout(root), oldId);
    if (typeof read === "string") throw new Error("Expected case.");
    expect(stoppedOwnerProblem(read, "boot-current")).toBe("delegate-recorded");

    const healed = await runHost({
      root,
      supersedeUnresolved: true,
      candidateRow: testCandidateRow(),
      factOverrides: { release: "7.0.0", bootIdentity: "boot-current" },
    });
    expect(healed.outcome.kind).toBe("ran");
    expect(healed.causeCode).toBe("SUCCESS_COMPLETED");
    expect(healed.envelope.result.superseded).toEqual([oldId]);
    expect(await healed.state.history(oldId)).toMatchObject({
      ok: true,
      history: {
        status: "closed",
        closure: {
          disposition: "outcome-unknown",
          qualification: supersededQualification,
        },
      },
    });
  },
);

supportingTest(
  "SU10b.same-boot-delegate-unflagged-refuses: unflagged transaction and close keep same-boot delegate refusal unchanged",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    appendDelegateStart(
      unflaggedWriteGate(),
      join(root, "operations", oldId, "events"),
      "editor.launch",
      "boot-current",
    );
    const unflagged = await runHost({ root });
    expect(unflagged.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);

    const read = readCase(layout(root), oldId);
    if (typeof read === "string") throw new Error("Expected case.");
    const fsType = read.intent.operationId.length > 0 ? 0x9123683e : 0;
    const closerState = stateAddonWithTestSeams(
      {
        root,
        report: "su.pending",
        observers: {
          "doc.write": () => Promise.resolve("present"),
          "editor.launch": () => Promise.resolve("present"),
        },
      },
      {
        fixtureLabel: "su-close",
        candidateRow: testCandidateRow(fsType),
        factOverrides: {
          release: "7.0.0",
          filesystem: fsType,
          bootIdentity: "boot-current",
        },
      },
    );
    let closeOutcome:
      | Awaited<ReturnType<typeof closerState.close<"case.close">>>
      | undefined;
    const pending = command({
      identity: "su.pending",
      route: ["pending"],
      summary: "Pending.",
      input: emptyInput,
      capabilities: {},
      stations: [
        station(allCauses, {
          ...stationWords,
          commandIdentity: "su.pending",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Read.",
          repairAction: null,
          guidance: { next: { kind: "instruction", text: "Inspect." } },
          independentObservable: "su.pending:read",
        }),
      ],
      run: (_input, context) =>
        context.result(
          { commandIdentity: "su.pending", causeCode: "SUCCESS_UNCHANGED" },
          { message: "Read.", data: null, effects: unchanged },
        ),
    });
    const closer = changing({
      identity: "su.close",
      route: ["close"],
      summary: "Close.",
      input: emptyInput,
      capabilities: {},
      effectClass: "repository-local",
      effects: ["case.close"],
      ifNoResult: closerState.descriptor.ifNoResult,
      heldLockCause: "DOMAIN_SU_LOCK_HELD",
      unresolvedCaseCause: "DOMAIN_SU_UNRESOLVED",
      stations: [
        station(allCauses, {
          ...stationWords,
          commandIdentity: "su.close",
          causeCode: "DOMAIN_SU_LOCK_HELD",
          trigger: "Held.",
          repairAction: "Wait.",
          guidance: handoff,
          independentObservable: "su.close:held",
        }),
        station(allCauses, {
          ...stationWords,
          commandIdentity: "su.close",
          causeCode: "DOMAIN_SU_UNRESOLVED",
          trigger: "Unresolved.",
          repairAction: "Inspect.",
          guidance: handoff,
          independentObservable: "su.close:unresolved",
        }),
        station(allCauses, {
          ...stationWords,
          commandIdentity: "su.close",
          causeCode: "DOMAIN_SU_UNAVAILABLE",
          trigger: "Unavailable.",
          repairAction: "Inspect.",
          guidance: handoff,
          independentObservable: "su.close:unavailable",
        }),
      ],
      run: async (_input, context) => {
        closeOutcome = await closerState.close(context.state, {
          command: "su.close",
          effect: "case.close" as const,
          operationId: oldId,
          closureId: "close-same-boot",
          disposition: "completed",
          revision: read.revision,
          reason: "attempt same-boot close",
        });
        return context.result(
          { commandIdentity: "su.close", causeCode: "DOMAIN_SU_UNAVAILABLE" },
          { message: closeOutcome.kind, data: null, effects: unchanged },
        );
      },
    });
    const contract = contractFor({
      cli: "su",
      commands: [pending, closer],
      causes: allCauses,
      state: closerState.descriptor,
      installedAddons: ["state"],
    });
    await runInProcess(contract, {
      emergencyRecord: closerState.emergencyRecord,
    })(["close"]);
    expect(closeOutcome).toMatchObject({
      kind: "unavailable",
      reason: "delegate-recorded",
    });
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
  },
);

supportingTest(
  "SU11.intent-published-before-closure-crash-leaves-blocked: crash before intent or between intent and closure leaves scope blocked and a later flagged run heals both",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);

    expect(await runCrashChild(root, "staged")).toBe(99);
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
    const blockedAfterStaged = await runHost({ root });
    expect(blockedAfterStaged.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldId,
    });

    expect(await runCrashChild(root, "closure-staged")).toBe(99);
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
    const afterCrash = stateAddon({ root, report: "su.pending" }).report();
    expect(afterCrash.ok).toBe(true);
    if (!afterCrash.ok) throw new Error("Expected report.");
    expect(afterCrash.unfinished).toHaveLength(2);
    const unresolvedIds = afterCrash.unfinished
      .map((entry) => entry.operationId)
      .sort();
    expect(unresolvedIds).toContain(oldId);

    const blockedAfterIntent = await runHost({ root });
    expect(blockedAfterIntent.outcome.kind).toBe("unresolved-case");

    const healedBoth = await runHost({ root, supersedeUnresolved: true });
    expect(healedBoth.outcome.kind).toBe("ran");
    expect(healedBoth.causeCode).toBe("SUCCESS_COMPLETED");
    expect(healedBoth.envelope.result.superseded).toEqual(unresolvedIds);
    expect(healedBoth.state.report()).toEqual({ ok: true, unfinished: [] });
    for (const id of unresolvedIds)
      expect(await healedBoth.state.history(id)).toMatchObject({
        ok: true,
        history: {
          status: "closed",
          closure: {
            disposition: "outcome-unknown",
            qualification: supersededQualification,
          },
        },
      });
  },
);

supportingTest(
  "SU12.failed-probe-refuses-lease-unreadable: a lease probe returning failed refuses lease-unreadable and never leads to a closure",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const base = resolveCoordination();
    if (!base.available) throw new Error("Coordination expected.");
    let ownerLeaseAttempts = 0;
    const coordination: CoordinationRoute = {
      ...base,
      tryLock(path, create) {
        if (path.endsWith("owner.lease")) {
          ownerLeaseAttempts += 1;
          if (ownerLeaseAttempts === 1)
            return { kind: "failed", code: "EMFILE" };
        }
        return base.tryLock(path, create);
      },
    };
    const phases: Phase[] = [];
    const second = await runHost({
      root,
      supersedeUnresolved: true,
      coordination,
      phase: (name) => {
        phases.push(name);
        return Promise.resolve();
      },
    });
    expect(second.outcome).toMatchObject({
      kind: "unavailable",
      reason: "lease-unreadable",
    });
    expect(ownerLeaseAttempts).toBe(1);
    expect(phases).not.toContain("closure-staged");
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);
  },
);

supportingTest(
  "SU13a.partial-scope-refuses-and-superset-heals: dead case on {A,B} refuses {A} with no closure and heals on {A,B} or {A,B,C}",
  async () => {
    const scopeAB: ScopeDeclaration = {
      resources: [
        { resource: "doc", key: "a" },
        { resource: "doc", key: "b" },
      ],
    };
    const scopeA: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "a" }],
    };
    const scopeABC: ScopeDeclaration = {
      resources: [
        { resource: "doc", key: "a" },
        { resource: "doc", key: "b" },
        { resource: "doc", key: "c" },
      ],
    };

    const root = stateRoot();
    const firstDead = await seedUnresolved(root, { scope: scopeAB });
    const partial = await runHost({
      root,
      scope: scopeA,
      supersedeUnresolved: true,
    });
    expect(partial.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: firstDead,
    });
    expect(existsSync(join(root, "operations", firstDead, "closure"))).toBe(
      false,
    );

    const exact = await runHost({
      root,
      scope: scopeAB,
      supersedeUnresolved: true,
    });
    expect(exact.outcome.kind).toBe("ran");
    expect(exact.envelope.result.superseded).toEqual([firstDead]);

    const secondDead = await seedUnresolved(root, { scope: scopeAB });
    const superset = await runHost({
      root,
      scope: scopeABC,
      supersedeUnresolved: true,
    });
    expect(superset.outcome.kind).toBe("ran");
    expect(superset.envelope.result.superseded).toEqual([secondDead]);
  },
);

supportingTest(
  "SU13b.unknown-scope-either-side-refuses: unknown scope on the dead case or the new run refuses unresolved-case with no closure",
  async () => {
    const knownScope: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "alpha" }],
    };
    const unknownScope: ScopeDeclaration = { unknown: true };

    const rootA = stateRoot();
    const deadUnknown = await seedUnresolved(rootA, { scope: unknownScope });
    const knownOverUnknown = await runHost({
      root: rootA,
      scope: knownScope,
      supersedeUnresolved: true,
    });
    expect(knownOverUnknown.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: deadUnknown,
    });
    expect(existsSync(join(rootA, "operations", deadUnknown, "closure"))).toBe(
      false,
    );

    const unknownOverUnknown = await runHost({
      root: rootA,
      scope: unknownScope,
      supersedeUnresolved: true,
    });
    expect(unknownOverUnknown.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: deadUnknown,
    });
    expect(existsSync(join(rootA, "operations", deadUnknown, "closure"))).toBe(
      false,
    );

    const rootB = stateRoot();
    const deadKnown = await seedUnresolved(rootB, { scope: knownScope });
    const unknownOverKnown = await runHost({
      root: rootB,
      scope: unknownScope,
      supersedeUnresolved: true,
    });
    expect(unknownOverKnown.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: deadKnown,
    });
    expect(existsSync(join(rootB, "operations", deadKnown, "closure"))).toBe(
      false,
    );
  },
);

supportingTest(
  "SU14.unsupported-filesystem-refuses-with-no-closure: NFS, overlay, CIFS, FUSE, unknown, macOS mismatch, unreadable filesystem, and cross-device folders refuse with no closure",
  async () => {
    const cases: FactOverrides[] = [
      { filesystem: 0x6969 },
      { filesystem: 0x794c7630 },
      { filesystem: 0xff534d42 },
      { filesystem: 0x65735546 },
      { filesystem: 0x12345678 },
      { filesystem: null },
      { devices: { operations: 999_999 } },
    ];
    if (process.platform === "darwin")
      cases.push({ filesystem: statfsSync("/").type + 1 });
    for (const factOverrides of cases) {
      const root = stateRoot();
      const oldId = await seedUnresolved(root);
      const phases: Phase[] = [];
      const blocked = await runHost({
        root,
        supersedeUnresolved: true,
        candidateRow: testCandidateRow(),
        factOverrides,
        phase: (name) => {
          phases.push(name);
          return Promise.resolve();
        },
      });
      expect(blocked.outcome).toMatchObject({
        kind: "unavailable",
        reason: supersedeFilesystemReason,
      });
      expect(phases).not.toContain("closure-read");
      expect(phases).not.toContain("closure-staged");
      expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(
        false,
      );
    }
  },
);

supportingTest(
  "SU15.envelope-reports-superseded-only-when-healing: healing envelope lists cleared operation ids, non-healing omits superseded, and invalid superseded envelopes fail validation",
  async () => {
    const root = stateRoot();
    const cleanRun = await runHost({ root, supersedeUnresolved: true });
    expect(cleanRun.outcome.kind).toBe("ran");
    expect(cleanRun.envelope.result.superseded).toBeUndefined();
    expect(Object.hasOwn(cleanRun.envelope.result, "superseded")).toBe(false);
    expect(cleanRun.published?.superseded).toBeUndefined();
    if (cleanRun.outcome.kind === "ran")
      expect(cleanRun.outcome.superseded).toBeUndefined();

    const oldId = await seedUnresolved(root);
    const healingRun = await runHost({ root, supersedeUnresolved: true });
    expect(healingRun.outcome.kind).toBe("ran");
    expect(healingRun.envelope.result.superseded).toEqual([oldId]);
    expect(healingRun.published?.superseded).toEqual([oldId]);
    expect(Object.isFrozen(healingRun.published?.superseded)).toBe(true);
    if (healingRun.outcome.kind === "ran") {
      expect(healingRun.outcome.superseded).toEqual([oldId]);
      expect(Object.isFrozen(healingRun.outcome.superseded)).toBe(true);
    }
    const history = await healingRun.state.history(oldId);
    expect(history).toMatchObject({
      ok: true,
      history: {
        status: "closed",
        closure: {
          disposition: "outcome-unknown",
          qualification: supersededQualification,
        },
      },
    });
    if (history.ok)
      expect(history.history.closure?.journalRevision).toMatch(
        /^r-[0-9a-f]{64}$/,
      );

    expect((await healingRun.validate(healingRun.envelope)).ok).toBe(true);
    const invalidLists: readonly (readonly string[])[] = [
      [],
      [
        "op-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "op-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      [oldId, oldId],
    ];
    for (const invalid of invalidLists)
      expect(
        (
          await healingRun.validate({
            ...healingRun.envelope,
            result: { ...healingRun.envelope.result, superseded: invalid },
          })
        ).ok,
      ).toBe(false);
    const pendingEnvelope = await healingRun.runPending();
    expect((await healingRun.validate(pendingEnvelope)).ok).toBe(true);
    expect(
      (
        await healingRun.validate({
          ...pendingEnvelope,
          result: { ...pendingEnvelope.result, superseded: [oldId] },
        })
      ).ok,
    ).toBe(false);
  },
);

type CustomRunOptions = {
  readonly root: string;
  readonly phase?: (name: Phase) => Promise<void>;
  readonly argv?: readonly string[];
  readonly deadlineSupported?: boolean;
  readonly programsAddon?: RunAddon<ProgramsCapability>;
  readonly declaration: (boundary: {
    readonly authority: ReturnType<typeof contractFor>["boundary"]["authority"];
    readonly resource: ReturnType<typeof contractFor>["boundary"]["resource"];
  }) => Declaration;
  readonly work?: (
    transaction: EffectTransaction<Effects>,
    published: PublishedOperation,
  ) => Promise<void>;
  readonly afterTransaction?: (outcome: TransactionResult<Effects>) => void;
  readonly catchTransaction?: (error: unknown) => void;
};

async function runCustomHost(options: CustomRunOptions): Promise<{
  readonly state: ReturnType<typeof stateAddon>;
  readonly outcome: TransactionResult<Effects> | undefined;
  readonly envelope: Envelope;
}> {
  const state = makeStateForHost({
    root: options.root,
    ...(options.phase === undefined ? {} : { phase: options.phase }),
  });
  let captured: TransactionResult<Effects> | undefined;
  const composed: {
    boundary?: ReturnType<typeof contractFor>["boundary"];
  } = {};
  const work =
    options.work ??
    (async (transaction: EffectTransaction<Effects>) => {
      for (const effect of defaultEffects)
        await transaction.record(
          effect,
          () => Promise.resolve(),
          () => Promise.resolve(true),
        );
    });
  const pending = command({
    identity: "su.pending",
    route: ["pending"],
    summary: "Report unfinished runs.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "su.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: {
          next: { kind: "instruction", text: "Inspect unfinished cases." },
        },
        independentObservable: "su.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "su.pending", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Read.", data: null, effects: unchanged },
      ),
  });
  const actorInput =
    options.deadlineSupported === true
      ? { ...emptyInput, deadlineSupported: true as const }
      : emptyInput;
  const actor = changing({
    identity: "su.open",
    route: ["open"],
    summary: "Run a changing command.",
    input: actorInput,
    capabilities:
      options.programsAddon === undefined ? {} : { programs: true as const },
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_SU_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_SU_UNRESOLVED",
    stations: [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "su.open",
        causeCode: "SUCCESS_COMPLETED",
        trigger: "Completed.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: "su.open:done",
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: "su.open",
        causeCode: "DOMAIN_SU_LOCK_HELD",
        trigger: "Held.",
        repairAction: "Wait for the live run.",
        guidance: handoff,
        independentObservable: "su.open:held",
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: "su.open",
        causeCode: "DOMAIN_SU_UNRESOLVED",
        trigger: "Unresolved.",
        repairAction: "Inspect unfinished cases.",
        guidance: handoff,
        independentObservable: "su.open:unresolved",
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: "su.open",
        causeCode: "DOMAIN_SU_UNAVAILABLE",
        trigger: "Unavailable.",
        repairAction: "Inspect state.",
        guidance: handoff,
        independentObservable: "su.open:unavailable",
      }),
    ],
    run: async (_input, context) => {
      const boundary = composed.boundary;
      if (!boundary) throw new Error("Boundary expected.");
      if ("programs" in context && context.programs !== undefined)
        await context.programs.inspect({
          executable: boundary.path(process.execPath),
          args: [],
          timeoutMilliseconds: 100,
          outputLimitBytes: 64,
          shutdownMilliseconds: 50,
        });
      let outcome: TransactionResult<Effects>;
      try {
        outcome = await state.transaction(
          context.state,
          options.declaration(boundary),
          (transaction, info) => work(transaction, info),
        );
      } catch (error) {
        if (options.catchTransaction) {
          options.catchTransaction(error);
          return context.result(
            { commandIdentity: "su.open", causeCode: "DOMAIN_SU_UNAVAILABLE" },
            { message: "threw", data: null, effects: unchanged },
          );
        }
        throw error;
      }
      captured = outcome;
      options.afterTransaction?.(outcome);
      if (outcome.kind !== "ran") {
        const causeCode =
          outcome.kind === "held-lock"
            ? "DOMAIN_SU_LOCK_HELD"
            : outcome.kind === "unresolved-case"
              ? "DOMAIN_SU_UNRESOLVED"
              : "DOMAIN_SU_UNAVAILABLE";
        return context.result(
          { commandIdentity: "su.open", causeCode },
          { message: outcome.kind, data: null, effects: unchanged },
        );
      }
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          { commandIdentity: "su.open", causeCode: "DOMAIN_SU_UNAVAILABLE" },
          { message: "unchanged", data: null, effects: unchanged },
        );
      return context.result(
        { commandIdentity: "su.open", causeCode: "SUCCESS_COMPLETED" },
        {
          message: outcome.proof.transactionState,
          data: null,
          transaction: outcome.proof,
        },
      );
    },
  });
  const contract = contractFor({
    cli: "su",
    commands: [pending, actor],
    causes: allCauses,
    state: state.descriptor,
    installedAddons:
      options.programsAddon === undefined ? ["state"] : ["state", "programs"],
  });
  composed.boundary = contract.boundary;
  const run = runInProcess(contract, {
    emergencyRecord: state.emergencyRecord,
    ...(options.programsAddon === undefined
      ? {}
      : { addons: { programs: options.programsAddon } }),
  });
  const ran = await run(options.argv ?? ["open"]);
  if (ran.kind !== "envelope") throw new Error("Expected envelope.");
  return { state, outcome: captured, envelope: ran.envelope };
}

supportingTest(
  "SU16.mutable-declaration-snapshot-before-admission: mutating declaration command or fields after admission cannot close another command's case or alter the published intent",
  async () => {
    const rootA = stateRoot();
    const oldOpen = await seedUnresolved(rootA, { command: "su.open" });
    const revisions: Record<string, string> = { version: "v1" };
    const facts: Record<string, string> = { note: "before" };
    let mutableA:
      | {
          command: string;
          scope: ScopeDeclaration;
          revisions: Record<string, string>;
          facts: Record<string, string>;
          supersedeUnresolved: boolean;
          approval: NonNullable<Declaration["approval"]>;
        }
      | undefined;
    const runtimeA: ApprovalRuntime = {
      check: () => Promise.resolve(true),
      revalidateAndConsume: () => {
        if (mutableA) {
          mutableA.command = "su.other";
          mutableA.supersedeUnresolved = false;
        }
        revisions.version = "v2";
        facts.note = "after";
        return Promise.resolve({ consumed: true });
      },
    };
    const healed = await runCustomHost({
      root: rootA,
      declaration: (boundary) => {
        mutableA = {
          command: "su.open",
          scope: { resources: [{ resource: "doc", key: "alpha" }] },
          revisions,
          facts,
          supersedeUnresolved: true,
          approval: {
            runtime: runtimeA,
            request: {
              authority: boundary.authority("operator"),
              resource: boundary.resource("doc"),
              resourceRevision: "v1",
              effects: defaultEffects,
              preview: "preview-1",
            },
          },
        };
        return mutableA;
      },
    });
    expect(healed.outcome?.kind).toBe("ran");
    if (healed.outcome?.kind !== "ran") throw new Error("Expected ran.");
    const publishedCase = readCase(layout(rootA), healed.outcome.operationId);
    if (typeof publishedCase === "string")
      throw new Error(`Expected new case, got ${publishedCase}.`);
    expect(publishedCase.intent.commandIdentity).toBe("su.open");
    expect(publishedCase.intent.revisions).toEqual({ version: "v1" });
    expect(publishedCase.intent.facts).toEqual({ note: "before" });
    expect(healed.envelope.result.superseded).toEqual([oldOpen]);

    const rootB = stateRoot();
    const oldOther = await seedUnresolved(rootB, { command: "su.other" });
    const mutableB: {
      command: string;
      scope: ScopeDeclaration;
      supersedeUnresolved: boolean;
    } = {
      command: "su.open",
      scope: { resources: [{ resource: "doc", key: "alpha" }] },
      supersedeUnresolved: true,
    };
    const blocked = await runCustomHost({
      root: rootB,
      phase: (name) => {
        if (name === "admission-wait") mutableB.command = "su.other";
        return Promise.resolve();
      },
      declaration: () => mutableB,
    });
    expect(blocked.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: oldOther,
    });
    expect(existsSync(join(rootB, "operations", oldOther, "closure"))).toBe(
      false,
    );
    expect(blocked.state.report()).toMatchObject({
      ok: true,
      unfinished: [{ operationId: oldOther }],
    });
  },
);

supportingTest(
  "SU17a.throwing-getter-during-intent-construction-releases-locks: a getter that throws during intent construction writes no closure and leaves no lock busy for the next run",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const throwingRevisions: Record<string, string> = {};
    Object.defineProperty(throwingRevisions, "version", {
      enumerable: true,
      get() {
        throw new Error("revisions getter failed");
      },
    });
    let thrown: unknown;
    await runCustomHost({
      root,
      declaration: () => ({
        command: "su.open",
        scope: { resources: [{ resource: "doc", key: "alpha" }] },
        revisions: throwingRevisions,
        supersedeUnresolved: true,
      }),
      catchTransaction: (error) => {
        thrown = error;
      },
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.message : "").toBe(
      "revisions getter failed",
    );
    expect(existsSync(join(root, "operations", oldId, "closure"))).toBe(false);

    const retry = await runHost({ root, supersedeUnresolved: true });
    expect(retry.outcome.kind).toBe("ran");
    expect(retry.causeCode).toBe("SUCCESS_COMPLETED");
    expect(retry.envelope.result.superseded).toEqual([oldId]);
  },
);

supportingTest(
  "SU17b.exception-after-supersede-leases-releases-all-locks: an exception after acquiring supersede owner leases releases every target lease, scope lock, and admission lock",
  async () => {
    const root = stateRoot();
    const scopeAlpha: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "alpha" }],
    };
    const scopeBeta: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "beta" }],
    };
    const scopeBoth: ScopeDeclaration = {
      resources: [
        { resource: "doc", key: "alpha" },
        { resource: "doc", key: "beta" },
      ],
    };
    const oldA = await seedUnresolved(root, { scope: scopeAlpha });
    const oldB = await seedUnresolved(root, { scope: scopeBeta });

    let reads = 0;
    let thrown: unknown;
    await runCustomHost({
      root,
      phase: (name) => {
        if (name === "closure-read") {
          reads += 1;
          if (reads === 2)
            return Promise.reject(new Error("boom after first target lease"));
        }
        return Promise.resolve();
      },
      declaration: () => ({
        command: "su.open",
        scope: scopeBoth,
        supersedeUnresolved: true,
      }),
      catchTransaction: (error) => {
        thrown = error;
      },
    });
    expect(thrown instanceof Error ? thrown.message : "").toBe(
      "boom after first target lease",
    );
    expect(existsSync(join(root, "operations", oldA, "closure"))).toBe(false);
    expect(existsSync(join(root, "operations", oldB, "closure"))).toBe(false);

    const route = resolveCoordination();
    if (!route.available) throw new Error("Coordination expected.");
    for (const id of [oldA, oldB]) {
      const check = route.tryLock(
        join(root, "operations", id, "owner.lease"),
        false,
      );
      expect(check.kind).toBe("held");
      if (check.kind === "held") check.release();
    }

    const retry = await runHost({
      root,
      scope: scopeBoth,
      supersedeUnresolved: true,
    });
    expect(retry.outcome.kind).toBe("ran");
    expect(retry.causeCode).toBe("SUCCESS_COMPLETED");
    expect(retry.envelope.result.superseded).toEqual([oldA, oldB].sort());
  },
);

supportingTest(
  "SU17c.refusal-after-target-lease-releases-owner-lease: approval refusal and later target busy release earlier leases, while publication holds the target lease",
  async () => {
    const route = resolveCoordination();
    if (!route.available) throw new Error("Coordination expected.");

    const rootA = stateRoot();
    const oldApproved = await seedUnresolved(rootA);
    const deniedRuntime: ApprovalRuntime = {
      check: () => Promise.resolve(false),
      revalidateAndConsume: () => Promise.resolve({ consumed: false }),
    };
    const denied = await runCustomHost({
      root: rootA,
      declaration: (boundary) => ({
        command: "su.open",
        scope: { resources: [{ resource: "doc", key: "alpha" }] },
        supersedeUnresolved: true,
        approval: {
          runtime: deniedRuntime,
          request: {
            authority: boundary.authority("operator"),
            resource: boundary.resource("doc"),
            resourceRevision: "v1",
            effects: defaultEffects,
            preview: "preview-deny",
          },
        },
      }),
    });
    expect(denied.outcome).toMatchObject({ kind: "denied" });
    expect(existsSync(join(rootA, "operations", oldApproved, "closure"))).toBe(
      false,
    );
    const probeAfterDeny = route.tryLock(
      join(rootA, "operations", oldApproved, "owner.lease"),
      false,
    );
    expect(probeAfterDeny.kind).toBe("held");
    if (probeAfterDeny.kind === "held") probeAfterDeny.release();

    let leaseBusyAtStaged: boolean | undefined;
    const healedAfterDeny = await runHost({
      root: rootA,
      supersedeUnresolved: true,
      phase: (name) => {
        if (name === "closure-staged") {
          const probe = route.tryLock(
            join(rootA, "operations", oldApproved, "owner.lease"),
            false,
          );
          leaseBusyAtStaged = probe.kind === "busy";
          if (probe.kind === "held") probe.release();
        }
        return Promise.resolve();
      },
    });
    expect(leaseBusyAtStaged).toBe(true);
    expect(healedAfterDeny.outcome.kind).toBe("ran");
    expect(healedAfterDeny.envelope.result.superseded).toEqual([oldApproved]);

    const rootB = stateRoot();
    const scopeAlpha: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "alpha" }],
    };
    const scopeBeta: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "beta" }],
    };
    const scopeBoth: ScopeDeclaration = {
      resources: [
        { resource: "doc", key: "alpha" },
        { resource: "doc", key: "beta" },
      ],
    };
    const oldOne = await seedUnresolved(rootB, { scope: scopeAlpha });
    const oldTwo = await seedUnresolved(rootB, { scope: scopeBeta });
    let readCount = 0;
    let releaseBusy: (() => void) | undefined;
    try {
      const partialBusy = await runHost({
        root: rootB,
        scope: scopeBoth,
        supersedeUnresolved: true,
        phase: (name) => {
          if (name === "closure-read") {
            readCount += 1;
            if (readCount === 2) {
              for (const id of [oldOne, oldTwo]) {
                const attempt = route.tryLock(
                  join(rootB, "operations", id, "owner.lease"),
                  false,
                );
                if (attempt.kind === "held") {
                  releaseBusy = attempt.release;
                  break;
                }
              }
            }
          }
          return Promise.resolve();
        },
      });
      expect(partialBusy.outcome.kind).toBe("held-lock");
    } finally {
      releaseBusy?.();
    }
    const healedBoth = await runHost({
      root: rootB,
      scope: scopeBoth,
      supersedeUnresolved: true,
    });
    expect(healedBoth.outcome.kind).toBe("ran");
    expect(healedBoth.envelope.result.superseded).toEqual(
      [oldOne, oldTwo].sort(),
    );
  },
);

supportingTest(
  "SU18a.unchanged-refusal-reports-superseded: an unchanged refusal after healing forwards closed operation ids in result.superseded",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const refused = await runHost({
      root,
      supersedeUnresolved: true,
      work: () => Promise.resolve(),
    });
    expect(refused.outcome.kind).toBe("ran");
    expect(refused.outcome.proof.transactionState).toBe("unchanged");
    if (refused.outcome.kind === "ran")
      expect(refused.outcome.superseded).toEqual([oldId]);
    expect(refused.envelope.result.outcome).toBe("refused");
    expect(refused.causeCode).toBe("DOMAIN_SU_UNAVAILABLE");
    expect(refused.envelope.result.superseded).toEqual([oldId]);
  },
);

supportingTest(
  "SU18b.partial-closure-publication-reports-closed-ids: when the first supersede closure publishes and a later one fails, the result reports the already closed id",
  async () => {
    const root = stateRoot();
    const scopeAlpha: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "alpha" }],
    };
    const scopeBeta: ScopeDeclaration = {
      resources: [{ resource: "doc", key: "beta" }],
    };
    const scopeBoth: ScopeDeclaration = {
      resources: [
        { resource: "doc", key: "alpha" },
        { resource: "doc", key: "beta" },
      ],
    };
    const oldA = await seedUnresolved(root, { scope: scopeAlpha });
    const oldB = await seedUnresolved(root, { scope: scopeBeta });
    let stagedCount = 0;
    let firstClosedId: string | undefined;
    let secondFailedId: string | undefined;

    const partial = await runHost({
      root,
      scope: scopeBoth,
      supersedeUnresolved: true,
      phase: (name) => {
        if (name === "closure-staged") {
          stagedCount += 1;
          if (stagedCount === 2) {
            const aClosed = existsSync(
              join(root, "operations", oldA, "closure"),
            );
            firstClosedId = aClosed ? oldA : oldB;
            secondFailedId = aClosed ? oldB : oldA;
            const secondRead = readCase(layout(root), secondFailedId);
            if (typeof secondRead === "string")
              throw new Error(`Expected second case, got ${secondRead}.`);
            writePriorClosure(root, secondFailedId, secondRead.revision);
          }
        }
        return Promise.resolve();
      },
    });
    if (!firstClosedId || !secondFailedId)
      throw new Error("Expected two closure-staged phases.");
    expect(partial.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: secondFailedId,
    });
    expect(partial.envelope.result.outcome).toBe("refused");
    expect(partial.envelope.result.superseded).toEqual([firstClosedId]);
  },
);

supportingTest(
  "SU18c.deadline-while-open-reports-superseded: a deadline expiring while the new transaction is still open reports closed ids in result.superseded",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const gate = deferred();
    const entered = deferred();
    try {
      const timedOut = await runCustomHost({
        root,
        argv: ["open", "--deadline-ms", "60"],
        deadlineSupported: true,
        declaration: () => ({
          command: "su.open",
          scope: { resources: [{ resource: "doc", key: "alpha" }] },
          supersedeUnresolved: true,
        }),
        work: async () => {
          entered.resolve();
          await gate.promise;
        },
      });
      await entered.promise;
      expect(timedOut.outcome).toBeUndefined();
      expect(timedOut.envelope.result.causeCode).toBe(
        "DOMAIN_DEADLINE_UNKNOWN",
      );
      expect(timedOut.envelope.result.superseded).toEqual([oldId]);
    } finally {
      gate.resolve();
    }
  },
);

supportingTest(
  "SU18d.unconfirmed-settlement-reports-superseded: an owned program surviving settlement preserves closed ids in the unknown result",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const survivingProgram: RunAddon<ProgramsCapability> = {
      attach: () => ({
        capability: Object.freeze({
          inspect: () =>
            Promise.resolve({
              stdout: "",
              stderr: "",
              exitCode: 0,
              terminationConfirmed: true,
              outputTruncated: false,
            }),
          supplied: () => Promise.reject(new Error("unused")),
          domain: () => {
            throw new Error("unused");
          },
        }),
        settle: () => Promise.resolve(false),
        killNow: () => undefined,
      }),
    };
    const survived = await runCustomHost({
      root,
      programsAddon: survivingProgram,
      declaration: () => ({
        command: "su.open",
        scope: { resources: [{ resource: "doc", key: "alpha" }] },
        supersedeUnresolved: true,
      }),
    });
    expect(survived.outcome?.kind).toBe("ran");
    expect(survived.envelope.result.causeCode).toBe("INTERNAL_RESULT_UNKNOWN");
    expect(survived.envelope.result.effects.inventoryComplete).toBe(false);
    expect(survived.envelope.result.superseded).toEqual([oldId]);
  },
);

supportingTest(
  "SU18e.fallback-after-heal-reports-superseded: a handler throwing after healing preserves closed ids on the fallback envelope",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const crashed = await runCustomHost({
      root,
      declaration: () => ({
        command: "su.open",
        scope: { resources: [{ resource: "doc", key: "alpha" }] },
        supersedeUnresolved: true,
      }),
      afterTransaction: () => {
        throw new Error("handler crashed after heal");
      },
    });
    expect(crashed.outcome?.kind).toBe("ran");
    expect(crashed.envelope.result.causeCode).toBe("INTERNAL_RESULT_COMPLETED");
    expect(crashed.envelope.result.superseded).toEqual([oldId]);
  },
);

supportingTest(
  "SU29.completion-append-fails-not-completed: a flagged run whose completion record cannot be appended reports unknown with an incomplete inventory, and the case stays unfinished",
  async () => {
    const root = stateRoot();
    let events = "";
    try {
      const ran = await runHost({
        root,
        supersedeUnresolved: true,
        work: async (transaction, published) => {
          for (const effect of defaultEffects)
            await transaction.record(
              effect,
              () => Promise.resolve(),
              () => Promise.resolve(true),
            );
          events = join(root, "operations", published.operationId, "events");
          chmodSync(events, 0o400);
        },
      });
      if (ran.outcome.kind !== "ran") throw new Error("Expected ran outcome.");
      expect(ran.causeCode).toBe("DOMAIN_SU_UNKNOWN");
      expect(ran.envelope.result.transactionState).toBe("unknown");
      expect(ran.envelope.result.effects).toEqual({
        completed: [...defaultEffects],
        remaining: [],
        uncertain: [],
        inventoryComplete: false,
      });
      const [operation, ...rest] = readOperations(root);
      expect(rest).toEqual([]);
      expect(operation?.events.records.map((record) => record.kind)).toEqual([
        "effect-started",
        "effect-confirmed",
        "effect-started",
        "effect-confirmed",
      ]);
      expect(ran.state.report()).toEqual({
        ok: true,
        unfinished: [
          {
            operationId: ran.outcome.operationId,
            commandIdentity: "su.open",
            runId: ran.runId,
            effects: [...defaultEffects].sort(),
          },
        ],
      });
    } finally {
      if (events !== "") chmodSync(events, 0o600);
    }
  },
  90_000,
  true,
);

supportingTest(
  "SU30.unused-intent-not-applied-append-fails: a refused flagged run whose not-applied record cannot be appended claims no effect, reports unknown with an incomplete inventory, leaves its unused intent pending, and the next flagged run supersedes it",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const before = await stateAddon({
      root,
      report: "su.pending",
    }).history(oldId);
    if (!before.ok) throw new Error("Expected history.");
    const unused: string[] = [];
    try {
      const refused = await runHost({
        root,
        supersedeUnresolved: true,
        phase: (name) => {
          if (name !== "closure-staged") return Promise.resolve();
          writePriorClosure(root, oldId, before.history.journal.revision);
          for (const id of readdirSync(join(root, "operations")))
            if (id !== oldId) {
              unused.push(id);
              chmodSync(join(root, "operations", id, "events"), 0o400);
            }
          return Promise.resolve();
        },
      });
      expect(refused.outcome).toMatchObject({
        kind: "unresolved-case",
        operationId: oldId,
      });
      expect(refused.causeCode).toBe("INTERNAL_RESULT_UNKNOWN");
      expect(refused.envelope.result.transactionState).toBe("unknown");
      expect(refused.envelope.result.effects).toEqual({
        completed: [],
        remaining: [...defaultEffects],
        uncertain: [],
        inventoryComplete: false,
      });
    } finally {
      for (const id of unused)
        chmodSync(join(root, "operations", id, "events"), 0o600);
    }
    const [unusedId, ...others] = unused;
    if (unusedId === undefined) throw new Error("No unused intent.");
    expect(others).toEqual([]);
    expect(
      readOperations(root)
        .find((entry) => entry.id === unusedId)
        ?.events.records.map((record) => record.kind),
    ).toEqual([]);
    const listed = stateAddon({ root, report: "su.pending" }).report();
    expect(
      listed.ok ? listed.unfinished.map((entry) => entry.operationId) : listed,
    ).toEqual([unusedId]);
    const next = await runHost({ root, supersedeUnresolved: true });
    expect(next.causeCode).toBe("SUCCESS_COMPLETED");
    expect(next.envelope.result.superseded).toEqual([unusedId]);
    expect(next.state.report()).toEqual({ ok: true, unfinished: [] });
  },
  90_000,
  true,
);

supportingTest(
  "SU31.closure-fault-with-not-applied-append-denied-proof: a flagged run whose supersede closure fails and whose own not-applied record cannot be appended returns a proof that is unknown with an incomplete inventory",
  async () => {
    const root = stateRoot();
    const oldId = await seedUnresolved(root);
    const unused: string[] = [];
    try {
      const refused = await runHost({
        root,
        supersedeUnresolved: true,
        phase: (name) => {
          if (name !== "closure-staged") return Promise.resolve();
          for (const id of readdirSync(join(root, "operations")))
            if (id !== oldId) {
              unused.push(id);
              chmodSync(join(root, "operations", id, "events"), 0o400);
            }
          return Promise.reject(new Error("planted closure publication fault"));
        },
      });
      expect(refused.outcome).toMatchObject({
        kind: "unavailable",
        reason: "closure-publication",
      });
      const listed = stateAddon({ root, report: "su.pending" }).report();
      expect(
        listed.ok
          ? listed.unfinished.map((entry) => entry.operationId).sort()
          : listed,
      ).toEqual([oldId, ...unused].sort());
      expect({
        transactionState: refused.outcome.proof.transactionState,
        inventoryComplete: refused.outcome.proof.effects.inventoryComplete,
      }).toEqual({ transactionState: "unknown", inventoryComplete: false });
    } finally {
      for (const id of unused)
        chmodSync(join(root, "operations", id, "events"), 0o600);
    }
  },
  90_000,
  true,
);
