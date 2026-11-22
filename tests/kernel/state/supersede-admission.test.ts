import { afterEach, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
} from "../../../kernel/src/kernel/index.ts";
import {
  stateAddon,
  supersededQualification,
} from "../../../kernel/src/addons/state/index.ts";
import type {
  Declaration,
  PublishedOperation,
  ScopeDeclaration,
  TransactionResult,
} from "../../../kernel/src/addons/state/index.ts";
import { stateAddonWithTestSeams } from "../../../kernel/src/addons/state/fixture.ts";
import type { Phase } from "../../../kernel/src/addons/state/fixture.ts";
import { resolveCoordination } from "../../../kernel/src/addons/state/coordination.ts";
import type {
  CoordinationRoute,
  LockAttempt,
} from "../../../kernel/src/addons/state/coordination.ts";
import { layout, readCase } from "../../../kernel/src/addons/state/store.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import { testFolder } from "../../support/test-folder.ts";
import { supportingTest } from "./harness.ts";

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
const handoff = {
  handoff: {
    owner: "operator",
    reason: "Manual check required.",
    inspect: [{ kind: "command", command: "su.pending", args: [] }],
  },
} as const;

type Effects = "doc.write" | "editor.launch";
const defaultEffects: readonly [Effects, ...Effects[]] = [
  "doc.write",
  "editor.launch",
];

const roots: string[] = [];
const restoreModes: string[] = [];
afterEach(() => {
  for (const path of restoreModes.splice(0)) {
    try {
      chmodSync(path, 0o700);
    } catch {
      continue;
    }
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function stateRoot(prefix = "c3-su-adm-"): string {
  const folder = testFolder(prefix);
  roots.push(folder);
  return join(folder, "state");
}

type Boundary = ReturnType<typeof contractFor>["boundary"];

type HostOptions = {
  readonly root: string;
  readonly command?: "su.open" | "su.other";
  readonly declaration: (boundary: Boundary) => Declaration;
  readonly phase?: (name: Phase) => Promise<void>;
  readonly coordination?: CoordinationRoute;
  readonly work?: (
    transaction: EffectTransaction<Effects>,
    published: PublishedOperation,
  ) => Promise<void>;
  readonly catchThrow?: boolean;
};

function makeState(options: HostOptions): ReturnType<typeof stateAddon> {
  const stateOptions = { root: options.root, report: "su.pending" };
  if (options.phase !== undefined || options.coordination !== undefined)
    return stateAddonWithTestSeams(stateOptions, {
      ...(options.phase === undefined ? {} : { phase: options.phase }),
      ...(options.coordination === undefined
        ? {}
        : { coordination: options.coordination }),
    });
  return stateAddon(stateOptions);
}

function actorStations(commandId: "su.open" | "su.other") {
  return [
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
      repairAction: "Wait.",
      guidance: handoff,
      independentObservable: `${commandId}:held`,
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: commandId,
      causeCode: "DOMAIN_SU_UNRESOLVED",
      trigger: "Unresolved.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: `${commandId}:unresolved`,
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: commandId,
      causeCode: "DOMAIN_SU_UNAVAILABLE",
      trigger: "Unavailable.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: `${commandId}:unavailable`,
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: commandId,
      causeCode: "DOMAIN_SU_PARTIAL",
      trigger: "Partial.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: `${commandId}:partial`,
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: commandId,
      causeCode: "DOMAIN_SU_UNKNOWN",
      trigger: "Unknown.",
      repairAction: "Inspect.",
      guidance: handoff,
      independentObservable: `${commandId}:unknown`,
    }),
  ];
}

function refusalCause(
  kind: string,
): "DOMAIN_SU_LOCK_HELD" | "DOMAIN_SU_UNRESOLVED" | "DOMAIN_SU_UNAVAILABLE" {
  if (kind === "held-lock") return "DOMAIN_SU_LOCK_HELD";
  return kind === "unresolved-case"
    ? "DOMAIN_SU_UNRESOLVED"
    : "DOMAIN_SU_UNAVAILABLE";
}

function ranCause(
  state: string,
): "SUCCESS_COMPLETED" | "DOMAIN_SU_PARTIAL" | "DOMAIN_SU_UNKNOWN" {
  if (state === "completed") return "SUCCESS_COMPLETED";
  return state === "partially-completed"
    ? "DOMAIN_SU_PARTIAL"
    : "DOMAIN_SU_UNKNOWN";
}

async function runHost(options: HostOptions): Promise<{
  readonly state: ReturnType<typeof stateAddon>;
  readonly outcome: TransactionResult<Effects> | undefined;
  readonly threw: string | undefined;
  readonly envelope: Envelope;
  readonly runId: string;
}> {
  const commandId = options.command ?? "su.open";
  const state = makeState(options);
  const holder: { boundary?: Boundary } = {};
  let captured: TransactionResult<Effects> | undefined;
  let threw: string | undefined;
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
  const actor = changing({
    identity: commandId,
    route: [commandId === "su.open" ? "open" : "other"],
    summary: "Run changing command.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: defaultEffects,
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_SU_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_SU_UNRESOLVED",
    stations: actorStations(commandId),
    run: async (_input, context) => {
      const boundary = holder.boundary;
      if (!boundary) throw new Error("Boundary expected.");
      let outcome: TransactionResult<Effects>;
      try {
        outcome = await state.transaction(
          context.state,
          options.declaration(boundary),
          work,
        );
      } catch (error) {
        if (!options.catchThrow) throw error;
        threw = error instanceof Error ? error.message : String(error);
        return context.result(
          { commandIdentity: commandId, causeCode: "DOMAIN_SU_UNAVAILABLE" },
          { message: "threw", data: null, effects: unchanged },
        );
      }
      captured = outcome;
      if (outcome.kind !== "ran")
        return context.result(
          { commandIdentity: commandId, causeCode: refusalCause(outcome.kind) },
          { message: outcome.kind, data: null, effects: unchanged },
        );
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          { commandIdentity: commandId, causeCode: "DOMAIN_SU_UNAVAILABLE" },
          { message: "unchanged", data: null, effects: unchanged },
        );
      return context.result(
        {
          commandIdentity: commandId,
          causeCode: ranCause(outcome.proof.transactionState),
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
    cli: "su",
    commands: [pending, actor],
    causes: allCauses,
    state: state.descriptor,
    installedAddons: ["state"],
  });
  holder.boundary = contract.boundary;
  const ran = await runInProcess(contract, {
    emergencyRecord: state.emergencyRecord,
  })([commandId === "su.open" ? "open" : "other"]);
  if (ran.kind !== "envelope")
    throw new Error(`Expected envelope, got ${ran.kind}.`);
  return {
    state,
    outcome: captured,
    threw,
    envelope: ran.envelope,
    runId: ran.runId,
  };
}

async function seedUnresolved(
  root: string,
  options: {
    readonly command?: "su.open" | "su.other";
    readonly scope?: ScopeDeclaration;
  } = {},
): Promise<string> {
  const commandId = options.command ?? "su.open";
  const scope: ScopeDeclaration = options.scope ?? {
    resources: [{ resource: "doc", key: "alpha" }],
  };
  const seeded = await runHost({
    root,
    command: commandId,
    declaration: () => ({ command: commandId, scope }),
    work: async (transaction) => {
      await transaction.record(
        "doc.write",
        () => Promise.resolve(),
        () => Promise.resolve(false),
      );
    },
  });
  if (seeded.outcome?.kind !== "ran") throw new Error("Expected ran outcome.");
  return seeded.outcome.operationId;
}

type DifferentialRow = {
  readonly name: string;
  readonly seedFirst: boolean;
  readonly declaration: () => Declaration;
  readonly expectedKind: TransactionResult<Effects>["kind"];
  readonly expectedCause: string;
  readonly expectedCommand?: string;
  readonly expectedScopeUnknown?: boolean;
  readonly expectedFacts?: unknown;
  readonly expectedRawProtoRevision?: boolean;
};

const alphaScope: ScopeDeclaration = {
  resources: [{ resource: "doc", key: "alpha" }],
};

function throwingRevisions(): Readonly<Record<string, string>> {
  const value: Record<string, string> = {};
  Object.defineProperty(value, "version", {
    enumerable: true,
    get() {
      throw new Error("rev-boom");
    },
  });
  return value;
}

function throwingFactsDeclaration(): Declaration {
  const value: Declaration = {
    command: "su.open",
    scope: alphaScope,
  };
  Object.defineProperty(value, "facts", {
    enumerable: true,
    get() {
      throw new Error("facts-boom");
    },
  });
  return value;
}

function ownProtoRevisions(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  Object.defineProperty(out, "__proto__", {
    value: "v1",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  out.a = "v2";
  return out;
}

function inheritedDeclaration(
  proto: object,
  own: PropertyDescriptorMap = {},
): Declaration {
  const base: Declaration = { command: "su.open", scope: alphaScope };
  Reflect.deleteProperty(base, "command");
  Reflect.deleteProperty(base, "scope");
  Object.setPrototypeOf(base, proto);
  Object.defineProperties(base, own);
  return base;
}

function changingCommandDeclaration(): Declaration {
  let reads = 0;
  return {
    get command() {
      reads += 1;
      return reads === 1 ? "su.open" : "su.second";
    },
    scope: alphaScope,
  };
}

const unflaggedDifferentialRows: readonly DifferentialRow[] = [
  {
    name: "function inside facts drops function during encoding and runs",
    seedFirst: false,
    declaration: () => ({
      command: "su.open",
      scope: alphaScope,
      facts: { note: "x", helper() {} },
    }),
    expectedKind: "ran",
    expectedCause: "SUCCESS_COMPLETED",
    expectedFacts: { note: "x" },
  },
  {
    name: "throwing revisions getter with conflict refuses unresolved-case",
    seedFirst: true,
    declaration: () => ({
      command: "su.open",
      scope: alphaScope,
      revisions: throwingRevisions(),
    }),
    expectedKind: "unresolved-case",
    expectedCause: "DOMAIN_SU_UNRESOLVED",
  },
  {
    name: "throwing facts getter with conflict refuses unresolved-case",
    seedFirst: true,
    declaration: throwingFactsDeclaration,
    expectedKind: "unresolved-case",
    expectedCause: "DOMAIN_SU_UNRESOLVED",
  },
  {
    name: "inherited command, scope, and facts run as on main",
    seedFirst: false,
    declaration: () =>
      inheritedDeclaration({
        command: "su.open",
        scope: alphaScope,
        facts: { from: "proto" },
      }),
    expectedKind: "ran",
    expectedCause: "SUCCESS_COMPLETED",
    expectedCommand: "su.open",
    expectedFacts: { from: "proto" },
  },
  {
    name: "own __proto__ revision key is preserved in encoded intent",
    seedFirst: false,
    declaration: () => ({
      command: "su.open",
      scope: alphaScope,
      revisions: ownProtoRevisions(),
    }),
    expectedKind: "ran",
    expectedCause: "SUCCESS_COMPLETED",
    expectedRawProtoRevision: true,
  },
  {
    name: "changing command getter uses second read in intent as on main",
    seedFirst: false,
    declaration: changingCommandDeclaration,
    expectedKind: "ran",
    expectedCause: "SUCCESS_COMPLETED",
    expectedCommand: "su.second",
  },
  {
    name: "malformed scope with empty resources canonicalises to unknown and runs",
    seedFirst: false,
    declaration: () => ({ command: "su.open", scope: { resources: [] } }),
    expectedKind: "ran",
    expectedCause: "SUCCESS_COMPLETED",
    expectedScopeUnknown: true,
  },
  {
    name: "malformed scope with empty key canonicalises to unknown and runs",
    seedFirst: false,
    declaration: () => ({
      command: "su.open",
      scope: { resources: [{ resource: "doc", key: "" }] },
    }),
    expectedKind: "ran",
    expectedCause: "SUCCESS_COMPLETED",
    expectedScopeUnknown: true,
  },
  {
    name: "inherited supersedeUnresolved stays unflagged and refuses unresolved-case",
    seedFirst: true,
    declaration: () =>
      inheritedDeclaration(
        { supersedeUnresolved: true },
        {
          command: { value: "su.open", enumerable: true, configurable: true },
          scope: { value: alphaScope, enumerable: true, configurable: true },
        },
      ),
    expectedKind: "unresolved-case",
    expectedCause: "DOMAIN_SU_UNRESOLVED",
  },
];

function assertStoredDifferential(
  root: string,
  row: DifferentialRow,
  operationId: string,
): void {
  const stored = readCase(layout(root), operationId);
  if (typeof stored === "string")
    throw new Error(`Expected stored case for ${row.name}, got ${stored}.`);
  if (row.expectedCommand !== undefined)
    expect(stored.intent.commandIdentity).toBe(row.expectedCommand);
  if (row.expectedScopeUnknown !== undefined)
    expect(stored.intent.scope.unknown).toBe(row.expectedScopeUnknown);
  if (row.expectedFacts !== undefined)
    expect(stored.intent.facts).toEqual(row.expectedFacts);
  if (row.expectedRawProtoRevision === true) {
    const raw = readFileSync(
      join(root, "operations", operationId, "intent"),
      "utf8",
    );
    expect(raw).toContain('"__proto__":"v1"');
  }
}

supportingTest(
  "SU19.unflagged-differential-matches-main: odd unflagged declarations and facts match origin/main byte-for-byte",
  async () => {
    for (const row of unflaggedDifferentialRows) {
      const root = stateRoot();
      if (row.seedFirst) await seedUnresolved(root);
      const result = await runHost({
        root,
        declaration: row.declaration,
        catchThrow: true,
      });
      expect({
        row: row.name,
        threw: result.threw,
        kind: result.outcome?.kind,
        cause: result.envelope.result.causeCode,
      }).toEqual({
        row: row.name,
        threw: undefined,
        kind: row.expectedKind,
        cause: row.expectedCause,
      });
      if (result.outcome?.kind === "ran")
        assertStoredDifferential(root, row, result.outcome.operationId);
    }
  },
);

function defineOneShot<T>(
  target: object,
  key: string,
  counts: Map<string, number>,
  label: string,
  first: T,
  second?: () => T,
): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      const seen = (counts.get(label) ?? 0) + 1;
      counts.set(label, seen);
      if (seen === 1) return first;
      if (second) return second();
      throw new Error(`second read on ${label}`);
    },
  });
}

function buildOneShotKeyDeclaration(
  boundary: Boundary,
  counts: Map<string, number>,
): Declaration {
  const resourceItem = { resource: "", key: "" };
  defineOneShot(resourceItem, "resource", counts, "res.resource", "doc");
  defineOneShot(resourceItem, "key", counts, "res.key", "alpha", () => "beta");
  const resources = [resourceItem];
  defineOneShot(resources, "0", counts, "res[0]", resourceItem);
  const invariants = ["inv-a"];
  defineOneShot(invariants, "0", counts, "inv[0]", "inv-a");
  const scope: ScopeDeclaration = { resources, invariants };
  defineOneShot(scope, "resources", counts, "scope.resources", resources);
  defineOneShot(scope, "invariants", counts, "scope.invariants", invariants);
  const revisions: Record<string, string> = {};
  defineOneShot(revisions, "version", counts, "rev.version", "v1");
  const facts: Record<string, string> = {};
  defineOneShot(facts, "note", counts, "facts.note", "first-read");
  const requestEffects = ["doc.write", "editor.launch"];
  defineOneShot(requestEffects, "0", counts, "req.effects[0]", "doc.write");
  defineOneShot(requestEffects, "1", counts, "req.effects[1]", "editor.launch");
  const request = {
    authority: boundary.authority("operator"),
    resource: boundary.resource("doc"),
    resourceRevision: "v1",
    effects: requestEffects,
    preview: "preview-1",
  };
  defineOneShot(
    request,
    "authority",
    counts,
    "req.authority",
    boundary.authority("operator"),
  );
  defineOneShot(
    request,
    "resource",
    counts,
    "req.resource",
    boundary.resource("doc"),
  );
  defineOneShot(request, "resourceRevision", counts, "req.revision", "v1");
  defineOneShot(request, "effects", counts, "req.effects", requestEffects);
  defineOneShot(request, "preview", counts, "req.preview", "preview-1");
  const runtime: ApprovalRuntime = {
    check: () => Promise.resolve(true),
    revalidateAndConsume: () => Promise.resolve({ consumed: true }),
  };
  const approval = { runtime, request };
  defineOneShot(approval, "runtime", counts, "approval.runtime", runtime);
  defineOneShot(approval, "request", counts, "approval.request", request);
  const declaration: Declaration = {
    command: "",
    scope,
    revisions,
    facts,
    approval,
    supersedeUnresolved: false,
  };
  defineOneShot(declaration, "command", counts, "decl.command", "su.open");
  defineOneShot(declaration, "scope", counts, "decl.scope", scope);
  defineOneShot(declaration, "revisions", counts, "decl.revisions", revisions);
  defineOneShot(declaration, "facts", counts, "decl.facts", facts);
  defineOneShot(declaration, "approval", counts, "decl.approval", approval);
  defineOneShot(declaration, "supersedeUnresolved", counts, "decl.flag", true);
  return declaration;
}

function buildOneShotPathDeclaration(
  file: string,
  counts: Map<string, number>,
): Declaration {
  const item = { resource: "", path: "" };
  defineOneShot(item, "resource", counts, "p.resource", "cfg");
  defineOneShot(item, "path", counts, "p.path", file);
  const resources = [item];
  defineOneShot(resources, "0", counts, "p.resources[0]", item);
  const scope: ScopeDeclaration = { resources };
  defineOneShot(scope, "resources", counts, "p.resources", resources);
  const decl: Declaration = { command: "", scope, supersedeUnresolved: false };
  defineOneShot(decl, "command", counts, "p.command", "su.open");
  defineOneShot(decl, "scope", counts, "p.scope", scope);
  defineOneShot(decl, "supersedeUnresolved", counts, "p.flag", true);
  return decl;
}

supportingTest(
  "SU20.proxy-read-count-once: flagged runs read every property of declaration and scope once and act on the first read",
  async () => {
    const root = stateRoot();
    const alphaId = await seedUnresolved(root, {
      scope: {
        resources: [{ resource: "doc", key: "alpha" }],
        invariants: ["inv-a"],
      },
    });
    const betaId = await seedUnresolved(root, {
      scope: { resources: [{ resource: "doc", key: "beta" }] },
    });
    const counts = new Map<string, number>();
    const healed = await runHost({
      root,
      declaration: (boundary) => buildOneShotKeyDeclaration(boundary, counts),
    });
    expect(healed.outcome?.kind).toBe("ran");
    expect(healed.envelope.result.causeCode).toBe("SUCCESS_COMPLETED");
    expect(healed.envelope.result.superseded).toEqual([alphaId]);
    expect(existsSync(join(root, "operations", betaId, "closure"))).toBe(false);
    expect(existsSync(join(root, "settled", betaId))).toBe(false);
    for (const [label, seen] of counts)
      expect({ label, seen }).toEqual({ label, seen: 1 });
    expect(counts.size).toBeGreaterThanOrEqual(18);
    if (healed.outcome?.kind === "ran") {
      const stored = readCase(layout(root), healed.outcome.operationId);
      if (typeof stored === "string") throw new Error("Expected new case.");
      expect(stored.intent.scope.resources[0]?.key).toBe("alpha");
      expect(stored.intent.facts).toEqual({ note: "first-read" });
      expect(stored.intent.revisions).toEqual({ version: "v1" });
    }

    const pathRoot = stateRoot();
    const workDir = join(pathRoot, "..", "work");
    mkdirSync(workDir, { recursive: true });
    const file = join(workDir, "target.txt");
    writeFileSync(file, "v1");
    const pathOldId = await seedUnresolved(pathRoot, {
      scope: { resources: [{ resource: "cfg", path: file }] },
    });
    const pathCounts = new Map<string, number>();
    const pathHealed = await runHost({
      root: pathRoot,
      declaration: () => buildOneShotPathDeclaration(file, pathCounts),
    });
    expect(pathHealed.outcome?.kind).toBe("ran");
    expect(pathHealed.envelope.result.superseded).toEqual([pathOldId]);
    for (const [label, seen] of pathCounts)
      expect({ label, seen }).toEqual({ label, seen: 1 });
  },
);

function closuresOnDiskByRun(root: string, runId: string): readonly string[] {
  const found: string[] = [];
  const paths = layout(root);
  for (const folder of [paths.operations, paths.settled]) {
    if (!existsSync(folder)) continue;
    for (const id of readdirSync(folder).sort()) {
      const read = readCase(paths, id);
      if (typeof read !== "string" && read.closure?.recoveryRunId === runId)
        found.push(id);
    }
  }
  return found.sort();
}

function countingRoute(
  base: Extract<CoordinationRoute, { readonly available: true }>,
  faultAt?: {
    readonly call: number;
    readonly mode: "failed" | "busy" | "throw";
  },
) {
  const held = new Set<string>();
  let calls = 0;
  let token = 0;
  const route: CoordinationRoute = {
    ...base,
    tryLock(path: string, create?: boolean): LockAttempt {
      calls += 1;
      if (faultAt && calls === faultAt.call) {
        if (faultAt.mode === "throw") throw new Error(`lock throw ${calls}`);
        return faultAt.mode === "busy"
          ? { kind: "busy" }
          : { kind: "failed", code: "EMFILE" };
      }
      const attempt = base.tryLock(path, create);
      if (attempt.kind !== "held") return attempt;
      token += 1;
      const key = `${token}:${path}`;
      held.add(key);
      return {
        kind: "held",
        release: () => {
          held.delete(key);
          attempt.release();
        },
      };
    },
  };
  return { route, held, getCalls: () => calls };
}

async function seedTwoUnresolved(root: string): Promise<{
  readonly ids: readonly string[];
  readonly scopeBoth: ScopeDeclaration;
}> {
  const oldA = await seedUnresolved(root, {
    scope: { resources: [{ resource: "doc", key: "alpha" }] },
  });
  const oldB = await seedUnresolved(root, {
    scope: { resources: [{ resource: "doc", key: "beta" }] },
  });
  return {
    ids: [oldA, oldB].sort(),
    scopeBoth: {
      resources: [
        { resource: "doc", key: "alpha" },
        { resource: "doc", key: "beta" },
      ],
    },
  };
}

async function sweepLockFaults(
  base: Extract<CoordinationRoute, { readonly available: true }>,
  totalLockCalls: number,
): Promise<void> {
  for (let call = 1; call <= totalLockCalls; call += 1) {
    for (const mode of ["failed", "throw"] as const) {
      const root = stateRoot();
      const seeded = await seedTwoUnresolved(root);
      const counter = countingRoute(base, { call, mode });
      const result = await runHost({
        root,
        coordination: counter.route,
        declaration: () => ({
          command: "su.open",
          scope: seeded.scopeBoth,
          supersedeUnresolved: true,
        }),
      });
      expect({ call, mode, held: counter.held.size }).toEqual({
        call,
        mode,
        held: 0,
      });
      expect({
        call,
        mode,
        reported: result.envelope.result.superseded ?? [],
      }).toEqual({
        call,
        mode,
        reported: closuresOnDiskByRun(root, result.runId),
      });
    }
  }
}

async function sweepPhaseFaults(
  base: Extract<CoordinationRoute, { readonly available: true }>,
): Promise<void> {
  const phaseFaults: readonly (readonly [Phase, number])[] = [
    ["admission-wait", 1],
    ["closure-read", 1],
    ["closure-read", 2],
    ["staged", 1],
    ["closure-staged", 1],
    ["closure-staged", 2],
    ["closure-published", 1],
    ["closure-published", 2],
  ];
  for (const [targetPhase, nth] of phaseFaults) {
    const root = stateRoot();
    const seeded = await seedTwoUnresolved(root);
    const counter = countingRoute(base);
    let seen = 0;
    const result = await runHost({
      root,
      coordination: counter.route,
      phase: (name) => {
        if (name !== targetPhase) return Promise.resolve();
        seen += 1;
        return seen === nth
          ? Promise.reject(new Error(`throw at ${name}#${nth}`))
          : Promise.resolve();
      },
      declaration: () => ({
        command: "su.open",
        scope: seeded.scopeBoth,
        supersedeUnresolved: true,
      }),
    });
    expect({ targetPhase, nth, held: counter.held.size }).toEqual({
      targetPhase,
      nth,
      held: 0,
    });
    expect({
      targetPhase,
      nth,
      reported: result.envelope.result.superseded ?? [],
    }).toEqual({
      targetPhase,
      nth,
      reported: closuresOnDiskByRun(root, result.runId),
    });
    const retry = await runHost({
      root,
      declaration: () => ({
        command: "su.open",
        scope: seeded.scopeBoth,
        supersedeUnresolved: true,
      }),
    });
    expect(retry.outcome?.kind).toBe("ran");
  }
}

async function sweepPostLinkFsFaults(
  base: Extract<CoordinationRoute, { readonly available: true }>,
): Promise<void> {
  for (const nth of [1, 2] as const) {
    const root = stateRoot();
    const seeded = await seedTwoUnresolved(root);
    const counter = countingRoute(base);
    const stagingDir = join(root, "staging");
    restoreModes.push(stagingDir);
    let stagedSeen = 0;
    const result = await runHost({
      root,
      coordination: counter.route,
      phase: (name) => {
        if (name === "closure-staged") {
          stagedSeen += 1;
          if (stagedSeen === nth) chmodSync(stagingDir, 0o500);
        }
        return Promise.resolve();
      },
      declaration: () => ({
        command: "su.open",
        scope: seeded.scopeBoth,
        supersedeUnresolved: true,
      }),
    });
    chmodSync(stagingDir, 0o700);
    expect(counter.held.size).toBe(0);
    const onDisk = closuresOnDiskByRun(root, result.runId);
    expect(onDisk.length).toBe(nth);
    expect(result.envelope.result.superseded ?? []).toEqual(onDisk);
    const retry = await runHost({
      root,
      declaration: () => ({
        command: "su.open",
        scope: seeded.scopeBoth,
        supersedeUnresolved: true,
      }),
    });
    expect(retry.outcome?.kind).toBe("ran");
  }
}

supportingTest(
  "SU21.throw-at-step-k-sweep: every lock fault, await throw, and post-link fs fault leaks zero locks and matches closures on disk",
  async () => {
    const base = resolveCoordination();
    if (!base.available) throw new Error("Coordination expected.");
    const baselineRoot = stateRoot();
    const baselineSeed = await seedTwoUnresolved(baselineRoot);
    const probe = countingRoute(base);
    const baseline = await runHost({
      root: baselineRoot,
      coordination: probe.route,
      declaration: () => ({
        command: "su.open",
        scope: baselineSeed.scopeBoth,
        supersedeUnresolved: true,
      }),
    });
    expect(baseline.outcome?.kind).toBe("ran");
    expect(probe.held.size).toBe(0);
    expect(probe.getCalls()).toBeGreaterThanOrEqual(5);
    await sweepLockFaults(base, probe.getCalls());
    await sweepPhaseFaults(base);
    await sweepPostLinkFsFaults(base);
  },
  30_000,
);

async function checkPathChangeCase(
  filename: string,
  mutate: (dir: string, file: string) => void,
): Promise<void> {
  const root = stateRoot();
  const dir = join(root, "..", "work");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, filename);
  writeFileSync(file, "v1");
  const scope: ScopeDeclaration = {
    resources: [{ resource: "cfg", path: file }],
  };
  const oldId = await seedUnresolved(root, { scope });
  mutate(dir, file);
  const healed = await runHost({
    root,
    declaration: () => ({
      command: "su.open",
      scope,
      supersedeUnresolved: true,
    }),
  });
  expect(healed.outcome?.kind).toBe("ran");
  expect(healed.envelope.result.superseded).toEqual([oldId]);
}

async function checkScopeRefusalProbes(): Promise<void> {
  const rootD = stateRoot();
  const wide: ScopeDeclaration = {
    resources: [
      { resource: "doc", key: "alpha" },
      { resource: "doc2", key: "beta" },
    ],
  };
  await seedUnresolved(rootD, { scope: wide });
  const narrow = await runHost({
    root: rootD,
    declaration: () => ({
      command: "su.open",
      scope: alphaScope,
      supersedeUnresolved: true,
    }),
  });
  expect(narrow.outcome?.kind).toBe("unresolved-case");
  const unknownNew = await runHost({
    root: rootD,
    declaration: () => ({
      command: "su.open",
      scope: { unknown: true },
      supersedeUnresolved: true,
    }),
  });
  expect(unknownNew.outcome?.kind).toBe("unresolved-case");
  const rootD2 = stateRoot();
  await seedUnresolved(rootD2, { scope: { unknown: true } });
  const unknownBoth = await runHost({
    root: rootD2,
    declaration: () => ({
      command: "su.open",
      scope: { unknown: true },
      supersedeUnresolved: true,
    }),
  });
  expect(unknownBoth.outcome?.kind).toBe("unresolved-case");
}

function assertRaceRound(
  root: string,
  deadId: string,
  operationId: string,
  runId: string,
  named: readonly string[],
): boolean {
  const still = readCase(layout(root), deadId);
  const mine = readCase(layout(root), operationId);
  const shared =
    typeof still !== "string" && typeof mine !== "string"
      ? mine.intent.scope.keys.filter((key) =>
          still.intent.scope.keys.includes(key),
        )
      : [];
  const stillUnresolved =
    typeof still !== "string" && still.status === "unresolved";
  expect(stillUnresolved && shared.length > 0 && !named.includes(deadId)).toBe(
    false,
  );
  expect(named).toEqual(closuresOnDiskByRun(root, runId));
  return stillUnresolved;
}

async function checkSymlinkRace(): Promise<void> {
  const rootRace = stateRoot();
  const dirRace = join(rootRace, "..", "work");
  mkdirSync(dirRace, { recursive: true });
  const targetA = join(dirRace, "a");
  const targetB = join(dirRace, "b");
  writeFileSync(targetA, "a");
  writeFileSync(targetB, "b");
  const link = join(dirRace, "current");
  symlinkSync(targetA, link);
  const raceScope: ScopeDeclaration = {
    resources: [{ resource: "cfg", path: link }],
  };
  let flips = 0;
  const flip = () => {
    flips += 1;
    const tmp = `${link}.tmp${flips}`;
    symlinkSync(flips % 2 === 0 ? targetA : targetB, tmp);
    renameSync(tmp, link);
  };
  for (let round = 0; round < 12; round += 1) {
    const deadId = await seedUnresolved(rootRace, { scope: raceScope });
    flip();
    const run = await runHost({
      root: rootRace,
      phase: () => {
        flip();
        return Promise.resolve();
      },
      declaration: () => ({
        command: "su.open",
        scope: raceScope,
        supersedeUnresolved: true,
      }),
    });
    if (run.outcome?.kind !== "ran") continue;
    const stillUnresolved = assertRaceRound(
      rootRace,
      deadId,
      run.outcome.operationId,
      run.runId,
      run.envelope.result.superseded ?? [],
    );
    if (stillUnresolved) {
      const cleanup = await runHost({
        root: rootRace,
        declaration: () => ({
          command: "su.open",
          scope: raceScope,
          supersedeUnresolved: true,
        }),
      });
      expect(cleanup.outcome?.kind).toBe("ran");
    }
  }
}

supportingTest(
  "SU22.moving-filesystem-and-probes: path replace, delete, unknown scopes, and symlink race follow declared resources",
  async () => {
    await checkPathChangeCase("config.json", (dir, file) => {
      writeFileSync(join(dir, "config.json.tmp"), "v2");
      renameSync(join(dir, "config.json.tmp"), file);
    });
    await checkPathChangeCase("scratch.txt", (_dir, file) => unlinkSync(file));
    await checkPathChangeCase("same.txt", () => {});
    await checkScopeRefusalProbes();
    await checkSymlinkRace();
  },
);

function killSupersedeChild(
  root: string,
  targetPhase: "closure-staged" | "closure-published" | "before-first-effect",
  nth: number,
): number | null {
  const script = `
    import { changing, command, commonCauses, contractFor, runInProcess, station } from "./kernel/src/kernel/index.ts";
    import { stateAddonWithTestSeams } from "./kernel/src/addons/state/fixture.ts";
    import { emptyInput, refusedHandoff, stationWords, unchanged } from "./tests/kernel/kernel-repair/shapes.ts";
    const [root, targetPhase, rawNth] = process.argv.slice(1);
    const nth = Number(rawNth);
    const causes = { ...commonCauses, DOMAIN_SU_LOCK_HELD: refusedHandoff, DOMAIN_SU_UNRESOLVED: refusedHandoff, DOMAIN_SU_UNAVAILABLE: refusedHandoff };
    const handoff = { handoff: { owner: "operator", reason: "Check.", inspect: [{ kind: "command", command: "su.pending", args: [] }] } };
    let seen = 0;
    const state = stateAddonWithTestSeams({ root, report: "su.pending" }, {
      phase: (name) => {
        if (name === targetPhase) {
          seen += 1;
          if (seen === nth) process.kill(process.pid, "SIGKILL");
        }
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
          scope: { resources: [{ resource: "doc", key: "alpha" }, { resource: "doc", key: "beta" }] },
          supersedeUnresolved: true,
        }, async (tx) => {
          if (targetPhase === "before-first-effect") process.kill(process.pid, "SIGKILL");
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
  const ran = Bun.spawnSync(
    [
      process.execPath,
      "--no-install",
      "-e",
      script,
      root,
      targetPhase,
      String(nth),
    ],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  return ran.exitCode;
}

supportingTest(
  "SU23.real-kills-at-every-durable-boundary: SIGKILL after intent, between two closures, and after last closure before first effect",
  async () => {
    const boundaries = [
      {
        label: "after-intent",
        phase: "closure-staged" as const,
        nth: 1,
        expectedClosedPrior: 0,
        expectedUnfinished: 3,
      },
      {
        label: "between-two-closures",
        phase: "closure-published" as const,
        nth: 1,
        expectedClosedPrior: 1,
        expectedUnfinished: 2,
      },
      {
        label: "after-last-closure-before-first-effect",
        phase: "before-first-effect" as const,
        nth: 1,
        expectedClosedPrior: 2,
        expectedUnfinished: 1,
      },
    ];
    for (const boundary of boundaries) {
      const root = stateRoot();
      const seeded = await seedTwoUnresolved(root);
      const exitCode = killSupersedeChild(root, boundary.phase, boundary.nth);
      expect({ label: boundary.label, nonZero: exitCode !== 0 }).toEqual({
        label: boundary.label,
        nonZero: true,
      });
      const closedPrior = seeded.ids.filter((id) => {
        const read = readCase(layout(root), id);
        return (
          typeof read !== "string" &&
          read.status === "closed" &&
          read.closure?.disposition === "outcome-unknown" &&
          read.closure.qualification === supersededQualification
        );
      });
      expect({
        label: boundary.label,
        closedPrior: closedPrior.length,
      }).toEqual({
        label: boundary.label,
        closedPrior: boundary.expectedClosedPrior,
      });
      const report = stateAddon({ root, report: "su.pending" }).report();
      if (!report.ok) throw new Error("Expected report.");
      expect({
        label: boundary.label,
        unfinished: report.unfinished.length,
      }).toEqual({
        label: boundary.label,
        unfinished: boundary.expectedUnfinished,
      });
      const blocked = await runHost({
        root,
        declaration: () => ({
          command: "su.open",
          scope: seeded.scopeBoth,
        }),
      });
      expect(blocked.outcome?.kind).toBe("unresolved-case");
      const remainingIds = report.unfinished
        .map((entry) => entry.operationId)
        .sort();
      const healed = await runHost({
        root,
        declaration: () => ({
          command: "su.open",
          scope: seeded.scopeBoth,
          supersedeUnresolved: true,
        }),
      });
      expect(healed.outcome?.kind).toBe("ran");
      expect(healed.envelope.result.superseded).toEqual(remainingIds);
      expect(healed.state.report()).toEqual({ ok: true, unfinished: [] });
    }
  },
  30_000,
);

supportingTest(
  "SU24.kernel-command-identity-authority: a command declaring another command's identity closes nothing",
  async () => {
    const root = stateRoot();
    const otherId = await seedUnresolved(root, { command: "su.other" });
    const attempt = await runHost({
      root,
      command: "su.open",
      declaration: () => ({
        command: "su.other",
        scope: alphaScope,
        supersedeUnresolved: true,
      }),
    });
    expect(attempt.outcome).toMatchObject({
      kind: "unresolved-case",
      operationId: otherId,
    });
    expect(attempt.envelope.result.superseded).toBeUndefined();
    expect(existsSync(join(root, "operations", otherId, "closure"))).toBe(
      false,
    );
    expect(existsSync(join(root, "settled", otherId, "closure"))).toBe(false);
    expect(attempt.state.report()).toMatchObject({
      ok: true,
      unfinished: [{ operationId: otherId }],
    });

    const cleanRoot = stateRoot();
    const cleanRun = await runHost({
      root: cleanRoot,
      command: "su.open",
      declaration: () => ({
        command: "su.other",
        scope: alphaScope,
        supersedeUnresolved: true,
      }),
    });
    expect(cleanRun.outcome?.kind).toBe("ran");
    if (cleanRun.outcome?.kind === "ran") {
      const stored = readCase(layout(cleanRoot), cleanRun.outcome.operationId);
      if (typeof stored === "string") throw new Error("Expected stored case.");
      expect(stored.intent.commandIdentity).toBe("su.open");
    }
  },
);
