// State add-on (CMD-10a to CMD-13a, REC-1 to REC-10). Imports only the
// kernel public index (CMD-17). The frozen storage and coordination design
// is DESIGN.md (journal version 1); this module implements it and nothing
// beyond it.
//
// Interface for a host:
// - stateAddon(options) installs once and returns:
//   - descriptor: give it to contractFor({ state }) and to approval runtime().
//   - emergencyRecord: give it to runProcess(contract, { emergencyRecord }).
//   - transaction(ctx.state, declaration, work): the only way a changing
//     handler opens its transaction. Scope comes from validated input and
//     is canonicalised before any coordination. Returns the transaction
//     proof plus what happened: ran, or one refusal kind.
//   - close(ctx.state, request): the recovery command's closure transaction.
//   - report() and history(operationId): read-only data for the host's
//     ifNoResult and case-history inspect commands.
//   - capabilities(): which gated capabilities are available, and why not.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { contractFor } from "../../kernel/index.ts";
import type {
  ApprovalRequest,
  ApprovalRuntime,
  EffectTransaction,
  EmergencyFacts,
  RecordedEffect,
  StateAddonDescriptor,
  StateCapability,
  StateIssuer,
  StateObservation,
  TransactionProof,
} from "../../kernel/index.ts";
import { coordinationAvailable, tryLock, waitLock } from "./coordination.ts";
import { resolveQualification } from "./qualification.ts";
import type { CapabilityReport, Qualification } from "./qualification.ts";
import { canonicalise, conflicts, currentKeys } from "./scope.ts";
import type { CanonicalScope, ScopeDeclaration } from "./scope.ts";
import {
  appendEvent,
  ensureStore,
  layout,
  operationPattern,
  publishClosure,
  publishOperation,
  readClosure,
  readOperation,
  readStore,
} from "./store.ts";
import type {
  Closure,
  Disposition,
  Intent,
  Layout,
  Operation,
} from "./store.ts";

export type { ScopeDeclaration } from "./scope.ts";
export type { Disposition } from "./store.ts";
export type { CapabilityReport, Qualification } from "./qualification.ts";

// Independent resource evidence for recovery (DESIGN.md section 8). A host
// observer is read-only. `excluded` means host evidence rules out that the
// attempted effect ever happened; `absent` is current absence only.
export type Observation = "present" | "excluded" | "absent" | "unobservable";
export type Observer = (input: {
  readonly effect: string;
  readonly operationId: string;
  readonly facts: unknown;
  readonly revisions: Readonly<Record<string, string>>;
}) => Promise<Observation>;

// Host observation points at frozen add-on-internal transitions: X06
// (`staged`: intent staged, not yet published) and X19 (`closure-staged`:
// closure staged, not yet linked). Production hosts pass nothing.
export type Phase = "staged" | "closure-staged";

export type StateOptions = {
  readonly root: string;
  readonly report: string;
  readonly observers?: Readonly<Record<string, Observer>>;
  readonly qualification?: Qualification;
  readonly phase?: (name: Phase) => Promise<void>;
  readonly admissionWaitMilliseconds?: number;
};

export type Declaration = {
  readonly command: string;
  readonly scope: ScopeDeclaration;
  readonly revisions?: Readonly<Record<string, string>>;
  readonly facts?: unknown;
  readonly approval?: {
    readonly runtime: ApprovalRuntime;
    readonly request: ApprovalRequest;
  };
};

export type Refusal =
  | { readonly kind: "held-lock"; readonly operationId: string }
  | { readonly kind: "unresolved-case"; readonly operationId: string }
  | { readonly kind: "busy" }
  | { readonly kind: "denied" }
  | { readonly kind: "approval-lost" }
  | { readonly kind: "approval-unavailable" }
  | { readonly kind: "unavailable"; readonly reason: string };

export type TransactionOutcome<Effect extends string> = {
  readonly proof: TransactionProof<Effect>;
} & (
  | {
      readonly kind: "ran";
      readonly operationId: string;
      // The host's work threw; the proof still reports every recorded fact.
      readonly workFailed: boolean;
    }
  | Refusal
);

export type CloseRequest<Effect extends string> = {
  // The host's recovery command identity, recorded in its own intent (REC-1).
  readonly command: string;
  readonly effect: Effect;
  readonly operationId: string;
  readonly closureId: string;
  readonly disposition: Disposition;
  readonly revision: string;
  readonly reason: string;
  // Presence of a human stop attestation (REC-7a). It is never read here:
  // human-assisted takeover is unavailable without a qualified row.
  readonly attestation?: boolean;
};

export type CloseOutcome<Effect extends string> = {
  readonly proof: TransactionProof<Effect>;
} & (
  | {
      readonly kind: "closed";
      readonly closure: Closure;
      readonly recoveryOperationId: string;
    }
  | { readonly kind: "already-closed"; readonly closure: Closure }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-unresolved" }
  | { readonly kind: "conflict" }
  | { readonly kind: "owner-live" }
  | { readonly kind: "stale-revision" }
  | {
      readonly kind: "evidence-insufficient";
      readonly classes: Readonly<Record<string, RecoveryClass>>;
    }
  | { readonly kind: "recovery-failed"; readonly recoveryOperationId: string }
  | Refusal
);

export type RecoveryClass = "completed" | "remaining" | "uncertain";

export type UnfinishedEntry = {
  readonly operationId: string;
  readonly commandIdentity: string;
  readonly runId: string;
  readonly effects: readonly string[];
};
export type ReportResult =
  | { readonly ok: true; readonly unfinished: readonly UnfinishedEntry[] }
  | {
      readonly ok: false;
      readonly reason: "missing" | "unreadable" | "corrupt";
    };
export type HistoryResult =
  | { readonly ok: true; readonly history: HistoryData }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "missing" | "unreadable" | "corrupt";
    };
export type HistoryData = {
  readonly operationId: string;
  readonly commandIdentity: string;
  readonly runId: string;
  readonly effects: readonly string[];
  readonly status: Operation["status"];
  readonly scope: {
    readonly resources: readonly {
      readonly resource: string;
      readonly keys: readonly string[];
    }[];
    readonly invariants: readonly string[];
    readonly unknown: boolean;
  };
  readonly revisions: Readonly<Record<string, string>>;
  readonly approvalReference: string | null;
  readonly closes: string | null;
  readonly journal: {
    readonly revision: string;
    readonly events: readonly {
      readonly kind: string;
      readonly effect: string | null;
    }[];
    readonly tornTail: boolean;
  };
  readonly observed: Readonly<Record<string, RecoveryClass>>;
  readonly closure: null | {
    readonly closureId: string;
    readonly disposition: Disposition;
    readonly reason: string;
    readonly journalRevision: string;
    readonly qualification: string;
    readonly evidence: readonly {
      readonly effect: string;
      readonly observation: string;
    }[];
  };
  readonly closureDamaged: boolean;
};

type Slot =
  | {
      readonly kind: "transaction";
      readonly declaration: Declaration;
      outcome?:
        | Refusal
        | {
            readonly kind: "ran";
            readonly operationId: string;
            readonly workFailed: boolean;
          };
    }
  | {
      readonly kind: "close";
      readonly request: CloseRequest<string>;
      outcome?: CloseResult;
    };
type CloseResult =
  | {
      readonly kind: "closed";
      readonly closure: Closure;
      readonly recoveryOperationId: string;
    }
  | { readonly kind: "already-closed"; readonly closure: Closure }
  | {
      readonly kind:
        | "not-found"
        | "not-unresolved"
        | "conflict"
        | "owner-live"
        | "stale-revision";
    }
  | {
      readonly kind: "evidence-insufficient";
      readonly classes: Readonly<Record<string, RecoveryClass>>;
    }
  | { readonly kind: "recovery-failed"; readonly recoveryOperationId: string }
  | Refusal;

type ActiveRun = {
  readonly events: string;
  emergencyWritten: boolean;
};

const closureIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const revisionPattern = /^r-[0-9a-f]{64}$/;

function unchangedObservation<Effect extends string>(
  remaining: readonly Effect[],
): StateObservation<Effect> {
  return {
    transactionState: "unchanged",
    effects: {
      completed: [],
      remaining,
      uncertain: [],
      inventoryComplete: true,
    },
  };
}

// Own-run proof from this run's records (DESIGN.md section 8 table).
function observationOf<Effect extends string>(
  declared: readonly Effect[],
  confirmed: readonly Effect[],
  started: readonly Effect[],
): StateObservation<Effect> {
  const completed = declared.filter((effect) => confirmed.includes(effect));
  const uncertain = declared.filter(
    (effect) => started.includes(effect) && !confirmed.includes(effect),
  );
  const remaining = declared.filter((effect) => !started.includes(effect));
  const [firstUncertain, ...restUncertain] = uncertain;
  if (firstUncertain !== undefined)
    return {
      transactionState: "unknown",
      effects: {
        completed,
        remaining,
        uncertain: [firstUncertain, ...restUncertain],
        inventoryComplete: true,
      },
    };
  const [firstCompleted, ...restCompleted] = completed;
  if (firstCompleted === undefined) return unchangedObservation(remaining);
  const [firstRemaining, ...restRemaining] = remaining;
  if (firstRemaining === undefined)
    return {
      transactionState: "completed",
      effects: {
        completed: [firstCompleted, ...restCompleted],
        remaining: [],
        uncertain: [],
        inventoryComplete: true,
      },
    };
  return {
    transactionState: "partially-completed",
    effects: {
      completed: [firstCompleted, ...restCompleted],
      remaining: [firstRemaining, ...restRemaining],
      uncertain: [],
      inventoryComplete: true,
    },
  };
}

function hex32(): string {
  return randomUUID().replaceAll("-", "");
}

// Recovery classification (DESIGN.md section 8): never from the journal
// alone, and absence never proves non-application.
async function observe(
  effect: string,
  operation: Operation,
  observers: Readonly<Record<string, Observer>>,
  paths: Layout,
): Promise<Observation> {
  if (operation.intent.closes !== null)
    return closureObservation(paths, operation);
  const observer = observers[effect];
  if (!observer) return "unobservable";
  try {
    return await observer({
      effect,
      operationId: operation.intent.operationId,
      facts: operation.intent.facts,
      revisions: operation.intent.revisions,
    });
  } catch {
    return "unobservable";
  }
}

function classOf(
  observed: Observation,
  started: boolean,
  tornTail: boolean,
): RecoveryClass {
  if (observed === "present") return "completed";
  if (observed === "excluded") return "remaining";
  return observed === "absent" && !started && !tornTail
    ? "remaining"
    : "uncertain";
}

async function classify(
  operation: Operation,
  observers: Readonly<Record<string, Observer>>,
  paths: Layout,
): Promise<Record<string, RecoveryClass>> {
  const classes: Record<string, RecoveryClass> = {};
  for (const effect of operation.intent.effects) {
    const started = operation.events.some(
      (event) => event.kind === "effect-started" && event.effect === effect,
    );
    classes[effect] = classOf(
      await observe(effect, operation, observers, paths),
      started,
      operation.tornTail,
    );
  }
  return classes;
}

type Acquired = Extract<
  Awaited<ReturnType<typeof acquire>>,
  { readonly ok: true }
>;

// A closure request that can never proceed: malformed, or asking for
// human-assisted takeover, which is never attempted without a reviewed row
// (REC-7a). The attestation is not read, so it is preserved.
function closeRequestProblem(
  request: CloseRequest<string>,
  effect: string | undefined,
): Refusal | undefined {
  if (
    !effect ||
    !operationPattern.test(request.operationId) ||
    !closureIdPattern.test(request.closureId) ||
    !revisionPattern.test(request.revision) ||
    request.reason.length === 0 ||
    request.command.length === 0
  )
    return { kind: "unavailable", reason: "declaration" };
  return request.attestation === true
    ? { kind: "unavailable", reason: "human-assisted-takeover-unqualified" }
    : undefined;
}

// A case already settled: the same closure again, a different settlement,
// damaged closure bytes, or its own run's final record.
function settledCheck(
  operation: Operation,
  request: CloseRequest<string>,
): CloseResult | undefined {
  const closure = operation.closure;
  if (closure)
    return closure.closureId === request.closureId &&
      closure.disposition === request.disposition &&
      closure.reason === request.reason
      ? { kind: "already-closed", closure }
      : { kind: "conflict" };
  if (operation.closureDamaged) return { kind: "conflict" };
  return operation.status === "unresolved"
    ? undefined
    : { kind: "not-unresolved" };
}

// Section 7.2: the candidate runtime proof needs a reviewed (or labelled
// fixture) row, no admitted delegate and no torn journal tail.
function stoppedOwnerProblem(
  qualification: Qualification,
  target: Operation,
): string | undefined {
  if (qualification.stoppedOwner === "unavailable")
    return "stopped-owner-proof-unqualified";
  if (target.events.some((event) => event.kind === "delegate-admitted"))
    return "delegate-recorded";
  return target.tornTail ? "journal-torn" : undefined;
}

function closureMatches(
  paths: Layout,
  closure: Closure,
  runId: string,
): boolean {
  const written = readClosure(paths, closure.operationId);
  return (
    typeof written === "object" &&
    written.closureId === closure.closureId &&
    written.recoveryRunId === runId
  );
}

// The add-on observes its own recovery effect: the closed case's closure
// record. Link publication never replaces a closure, so a closure written by
// another recovery run excludes this one's publication.
function closureObservation(paths: Layout, operation: Operation): Observation {
  const target = operation.intent.closes;
  if (target === null) return "unobservable";
  const written = readClosure(paths, target);
  if (written === "damaged") return "unobservable";
  if (written === undefined) return "absent";
  return written.recoveryRunId === operation.intent.runId
    ? "present"
    : "excluded";
}

type Held = { readonly release: () => void };

// Admission ordering (DESIGN.md section 7.1 steps 2 and 3): the admission
// coordination lock first (bounded wait), then key coordination locks in
// ascending lock-file name order, non-blocking.
async function acquire(
  paths: Layout,
  keys: readonly string[],
  boundMilliseconds: number,
): Promise<
  | {
      readonly ok: true;
      readonly admission: Held;
      readonly keys: Held;
      readonly order: readonly string[];
    }
  | { readonly ok: false; readonly refusal: Refusal }
> {
  const admission = await waitLock(paths.admission, boundMilliseconds);
  if (admission.kind === "busy")
    return { ok: false, refusal: { kind: "busy" } };
  if (admission.kind === "failed")
    return {
      ok: false,
      refusal: { kind: "unavailable", reason: "coordination-failed" },
    };
  const files = [...new Set(keys.map(paths.keyLock))].sort();
  const held: (() => void)[] = [];
  const releaseKeys = () => {
    for (const release of held.reverse()) release();
    held.length = 0;
  };
  for (const file of files) {
    const attempt = tryLock(file);
    if (attempt.kind === "held") {
      held.push(attempt.release);
      continue;
    }
    releaseKeys();
    // Still under the admission lock: the holder of a key coordination lock
    // has published its intent, so the live owner can be named. If it has
    // already gone, the condition was temporary.
    const owner = attempt.kind === "busy" ? liveHolder(paths, keys) : undefined;
    admission.release();
    return {
      ok: false,
      refusal:
        attempt.kind !== "busy"
          ? { kind: "unavailable", reason: "coordination-failed" }
          : owner === undefined
            ? { kind: "busy" }
            : { kind: "held-lock", operationId: owner },
    };
  }
  return {
    ok: true,
    admission,
    keys: { release: releaseKeys },
    order: files.map((file) => file.slice(file.lastIndexOf("/") + 1)),
  };
}

// The live operation whose scope conflicts with `keys`, whatever its status.
function liveHolder(
  paths: Layout,
  keys: readonly string[],
): string | undefined {
  const store = readStore(paths);
  if (!store.ok) return undefined;
  const closers = liveClosers(paths, store.operations);
  for (const operation of store.operations) {
    const id = operation.intent.operationId;
    if (!conflicts(keys, currentKeys(operation.intent.scope))) continue;
    if (probeLease(paths, id) === "live") return closers.get(id) ?? id;
  }
  return undefined;
}

// A live closure holds its target's lease, so a held target lease names the
// closing recovery run's operation, not the target's (stopped) owner.
function liveClosers(
  paths: Layout,
  operations: readonly Operation[],
): ReadonlyMap<string, string> {
  const closers = new Map<string, string>();
  for (const operation of operations) {
    const target = operation.intent.closes;
    if (
      target !== null &&
      operation.status === "unresolved" &&
      probeLease(paths, operation.intent.operationId) === "live"
    )
      closers.set(target, operation.intent.operationId);
  }
  return closers;
}

// Live-owner probe of one case's lease (section 7.2). "live" when held.
function probeLease(paths: Layout, id: string): "live" | "free" {
  const attempt = tryLock(join(paths.operation(id), "owner.lease"), false);
  if (attempt.kind === "held") {
    attempt.release();
    return "free";
  }
  return attempt.kind === "busy" ? "live" : "free";
}

// Under coordination: the first conflicting case, live owners first.
function blocking(
  paths: Layout,
  operations: readonly Operation[],
  keys: readonly string[] | undefined,
  options: { readonly liveOnly: boolean; readonly except?: string },
): Refusal | undefined {
  const closers = liveClosers(paths, operations);
  let unresolved: string | undefined;
  for (const operation of operations) {
    const id = operation.intent.operationId;
    if (operation.status !== "unresolved" || id === options.except) continue;
    if (!conflicts(keys, currentKeys(operation.intent.scope))) continue;
    if (probeLease(paths, id) === "live")
      return { kind: "held-lock", operationId: closers.get(id) ?? id };
    unresolved ??= id;
  }
  return unresolved === undefined || options.liveOnly
    ? undefined
    : { kind: "unresolved-case", operationId: unresolved };
}

function rejectionConsumed(error: unknown): boolean | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const consumed: unknown = Reflect.get(error, "consumed");
  return typeof consumed === "boolean" ? consumed : undefined;
}

export function stateAddon(options: StateOptions) {
  const paths = layout(options.root);
  const observers = options.observers ?? {};
  const phase = options.phase ?? (() => Promise.resolve());
  const bound = Math.min(
    Math.max(options.admissionWaitMilliseconds ?? 2_000, 1),
    10_000,
  );
  const slots = new WeakMap<object, Slot>();
  const active = new Map<string, ActiveRun>();

  const descriptor: StateAddonDescriptor = contractFor.stateAddon((issuer) => {
    return {
      ifNoResult: issuer.ifNoResult({
        kind: "command",
        command: options.report,
        args: [],
      }),
      attach<Effect extends string>(
        runId: string,
        effects: readonly Effect[],
      ): StateCapability<Effect> {
        return {
          transaction: (work) => run(issuer, runId, effects, work),
        };
      },
    };
  });

  async function run<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
  ): Promise<TransactionProof<Effect>> {
    const slot = slots.get(work);
    if (!slot)
      throw new Error(
        "Open state transactions through the state add-on's transaction() or close().",
      );
    slots.delete(work);
    const refuse = (refusal: Refusal) => {
      slot.outcome = refusal;
      return issuer.transactionProof(runId, unchangedObservation<Effect>([]));
    };
    if (!coordinationAvailable())
      return refuse({
        kind: "unavailable",
        reason: "coordination-unqualified-platform",
      });
    if (!ensureStore(paths))
      return refuse({ kind: "unavailable", reason: "store" });
    return slot.kind === "transaction"
      ? transact(issuer, runId, declared, work, slot, refuse)
      : closeCase(issuer, runId, declared, slot);
  }

  // Publishes this run's intent and returns its live operation handle.
  async function begin(
    runId: string,
    intent: Omit<Intent, "operationId" | "runId" | "owner">,
  ) {
    const operationId = `op-${hex32()}`;
    const full: Intent = {
      ...intent,
      operationId,
      runId,
      owner: { lease: "owner.lease", pid: process.pid, startedAt: Date.now() },
    };
    let ready = false;
    const published = await publishOperation(
      paths,
      full,
      (lease) => {
        const attempt = tryLock(lease);
        return attempt.kind === "held" ? attempt.release : undefined;
      },
      async () => {
        await phase("staged");
        ready = true;
      },
    );
    if (!published.ok || !ready) return undefined;
    const handle: ActiveRun = {
      events: published.events,
      emergencyWritten: false,
    };
    active.set(runId, handle);
    return {
      operationId,
      events: published.events,
      releaseLease: published.releaseLease,
      handle,
    };
  }

  // Section 7.1 steps 2 to 4: coordination, then the unresolved-case and
  // live-owner check under it. `release` frees both coordination layers.
  async function coordinate(
    keys: readonly string[] | undefined,
    lockKeys: readonly string[],
    check: { readonly liveOnly: boolean; readonly except?: string },
  ): Promise<
    | { readonly ok: false; readonly refusal: Refusal }
    | {
        readonly ok: true;
        readonly held: Acquired;
        readonly operations: readonly Operation[];
        readonly release: () => void;
        readonly isActive: () => boolean;
      }
  > {
    const held = await acquire(paths, lockKeys, bound);
    if (!held.ok) return held;
    let current = true;
    const release = () => {
      current = false;
      held.keys.release();
      held.admission.release();
    };
    const store = readStore(paths);
    const refusal: Refusal | undefined = !store.ok
      ? { kind: "unavailable", reason: `store-${store.reason}` }
      : blocking(paths, store.operations, keys, check);
    if (refusal || !store.ok) {
      release();
      return {
        ok: false,
        refusal: refusal ?? { kind: "unavailable", reason: "store" },
      };
    }
    return {
      ok: true,
      held,
      operations: store.operations,
      release,
      isActive: () => current,
    };
  }

  // CMD-9 step 7: revalidate and consume under the issued exclusive scope,
  // before the intent. Denial, consumed-then-lost and store failure differ.
  async function consumeApproval(
    issuer: StateIssuer,
    runId: string,
    declaration: Declaration,
    scope: CanonicalScope,
    isActive: () => boolean,
  ): Promise<Refusal | Intent["approval"]> {
    if (!declaration.approval) return null;
    const { runtime, request } = declaration.approval;
    const resource = String(request.resource);
    if (
      typeof request.preview !== "string" ||
      !scope.resources.some((item) => item.resource === resource)
    )
      return { kind: "unavailable", reason: "approval-resource-undeclared" };
    const coordination = issuer.exclusiveScope(runId, resource, isActive);
    try {
      const { admitted } = await runtime.revalidateAndConsume(
        request,
        coordination,
      );
      return admitted
        ? { kind: "preview", reference: request.preview }
        : { kind: "denied" };
    } catch (error) {
      return rejectionConsumed(error) === true
        ? { kind: "approval-lost" }
        : { kind: "approval-unavailable" };
    }
  }

  // Publishes the intent, then releases the admission coordination lock.
  async function open(
    runId: string,
    intent: Omit<Intent, "operationId" | "runId" | "owner">,
    held: Acquired,
  ) {
    let opened: Awaited<ReturnType<typeof begin>>;
    try {
      opened = await begin(runId, intent);
    } catch {
      opened = undefined;
    }
    held.admission.release();
    return opened;
  }

  // Runs the host's work against this run's own records and ends the run's
  // own listing with its final event (section 8 table).
  async function runRecorded<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    events: string,
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
  ) {
    const started: Effect[] = [];
    const confirmed: Effect[] = [];
    let workFailed = false;
    try {
      await work(recorder(issuer, runId, declared, events, started, confirmed));
    } catch {
      workFailed = true;
    }
    const observation = observationOf(declared, confirmed, started);
    finish(events, observation);
    active.delete(runId);
    return { observation, workFailed };
  }

  async function transact<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
    slot: Extract<Slot, { kind: "transaction" }>,
    refuse: (refusal: Refusal) => TransactionProof<Effect>,
  ): Promise<TransactionProof<Effect>> {
    const declaration = slot.declaration;
    if (declared.length === 0 || declaration.command.length === 0)
      return refuse({ kind: "unavailable", reason: "declaration" });
    // Scope from validated input, before any coordination (REC-2).
    const scope: CanonicalScope = canonicalise(declaration.scope);
    const keys = scope.unknown ? undefined : scope.keys;
    const admitted = await coordinate(keys, keys ?? [], { liveOnly: false });
    if (!admitted.ok) return refuse(admitted.refusal);
    const approval = await consumeApproval(
      issuer,
      runId,
      declaration,
      scope,
      admitted.isActive,
    );
    if (approval !== null && approval.kind !== "preview") {
      admitted.release();
      return refuse(approval);
    }
    const opened = await open(
      runId,
      {
        commandIdentity: declaration.command,
        effects: [...new Set<string>(declared)].sort(),
        scope,
        revisions: { ...declaration.revisions },
        facts: declaration.facts ?? null,
        approval,
        closes: null,
        coordination: admitted.held.order,
      },
      admitted.held,
    );
    if (!opened) {
      admitted.release();
      return refuse({ kind: "unavailable", reason: "store-publication" });
    }
    const { observation, workFailed } = await runRecorded(
      issuer,
      runId,
      declared,
      opened.events,
      work,
    );
    admitted.release();
    opened.releaseLease();
    slot.outcome = { kind: "ran", operationId: opened.operationId, workFailed };
    return issuer.transactionProof(runId, observation);
  }

  function finish<Effect extends string>(
    events: string,
    observation: StateObservation<Effect>,
  ) {
    const effects = observation.effects;
    try {
      if (observation.transactionState === "completed")
        appendEvent(events, "completion", {
          completed: [...effects.completed],
        });
      else if (observation.transactionState === "unchanged")
        appendEvent(events, "not-applied", {
          remaining: [...effects.remaining],
        });
      else
        appendEvent(events, "outcome", {
          transactionState: observation.transactionState,
          completed: [...effects.completed],
          remaining: [...effects.remaining],
          uncertain: [...effects.uncertain],
        });
    } catch {
      // Without a durable final record the case stays listed: honest.
    }
  }

  // EffectTransaction for one admitted operation (DESIGN.md section 8).
  function recorder<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    events: string,
    started: Effect[],
    confirmed: Effect[],
  ): EffectTransaction<Effect> {
    return {
      async record<T>(
        effect: Effect,
        operation: (capability: RecordedEffect<Effect>) => Promise<T>,
        readBack: (result: T) => Promise<boolean>,
      ): Promise<T> {
        if (!declared.includes(effect) || started.includes(effect))
          throw new Error("Undeclared or already recorded effect.");
        appendEvent(events, "effect-started", { effect });
        started.push(effect);
        const lifetime: {
          state: "active" | "closing";
          inflight: number;
          wake: () => void;
        } = { state: "active", inflight: 0, wake: () => {} };
        const admitStart = <R>(
          startRun: string,
          startEffect: Effect,
          start: () => Promise<R>,
        ): Promise<R> => {
          if (
            startRun !== runId ||
            startEffect !== effect ||
            lifetime.state !== "active"
          )
            return Promise.reject(
              new Error("The recorded effect is not active for this run."),
            );
          try {
            appendEvent(events, "delegate-admitted", { effect });
          } catch (error) {
            return Promise.reject(
              error instanceof Error
                ? error
                : new Error("delegate record failed"),
            );
          }
          lifetime.inflight += 1;
          let pending: Promise<R>;
          try {
            pending = start();
          } catch (error) {
            pending = Promise.reject(
              error instanceof Error ? error : new Error("start failed"),
            );
          }
          return pending.finally(() => {
            lifetime.inflight -= 1;
            if (lifetime.inflight === 0) lifetime.wake();
          });
        };
        const capability = issuer.recordedEffect(runId, effect, admitStart);
        let result: T;
        try {
          result = await operation(capability);
        } catch (error) {
          lifetime.state = "closing";
          await settled(lifetime);
          appendEvent(events, "effect-unconfirmed", {
            effect,
            reason: "operation-failed",
          });
          throw error;
        }
        lifetime.state = "closing";
        await settled(lifetime);
        let present = false;
        let reason = "read-back-false";
        try {
          present = (await readBack(result)) === true;
        } catch {
          reason = "read-back-failed";
        }
        if (present) {
          appendEvent(events, "effect-confirmed", { effect });
          confirmed.push(effect);
        } else appendEvent(events, "effect-unconfirmed", { effect, reason });
        return result;
      },
    };
  }

  // The stopped-owner condition and the requested disposition's evidence,
  // evaluated under coordination (REC-3, REC-4, REC-7, sections 7.2 and 8).
  async function closureDecision(
    target: Operation,
    request: CloseRequest<string>,
    runId: string,
  ): Promise<CloseResult | Closure> {
    const qualification = resolveQualification(options.qualification);
    const reason = stoppedOwnerProblem(qualification, target);
    if (reason) return { kind: "unavailable", reason };
    if (target.revision !== request.revision) return { kind: "stale-revision" };
    if (request.disposition === "outcome-unknown")
      return { kind: "unavailable", reason: "human-closure-unqualified" };
    const classes = await classify(target, observers, paths);
    const wanted: RecoveryClass =
      request.disposition === "completed" ? "completed" : "remaining";
    if (Object.values(classes).some((value) => value !== wanted))
      return { kind: "evidence-insufficient", classes };
    return {
      operationId: request.operationId,
      closureId: request.closureId,
      disposition: request.disposition,
      reason: request.reason,
      evidence: target.intent.effects.map((name) => ({
        effect: name,
        observation:
          classes[name] === "completed"
            ? "present"
            : "excluded-or-never-started",
      })),
      authority: null,
      journalRevision: target.revision,
      qualification: qualification.label,
      recoveryRunId: runId,
    };
  }

  // Coordination over the case: its keys, its case key and its owner lease.
  async function admitClosure(
    request: CloseRequest<string>,
    targetKeys: readonly string[] | undefined,
  ): Promise<
    | { readonly ok: false; readonly stop: CloseResult }
    | {
        readonly ok: true;
        readonly held: Acquired;
        readonly target: Operation;
        readonly release: () => void;
      }
  > {
    const id = request.operationId;
    const admitted = await coordinate(
      targetKeys,
      [...(targetKeys ?? []), `case:${id}`],
      { liveOnly: true, except: id },
    );
    if (!admitted.ok)
      return {
        ok: false,
        stop:
          admitted.refusal.kind === "held-lock" &&
          admitted.refusal.operationId === id
            ? { kind: "owner-live" }
            : admitted.refusal,
      };
    const lease = tryLock(join(paths.operation(id), "owner.lease"), false);
    const target = admitted.operations.find(
      (operation) => operation.intent.operationId === id,
    );
    const stop: CloseResult | undefined =
      lease.kind === "busy"
        ? { kind: "owner-live" }
        : lease.kind === "failed"
          ? { kind: "unavailable", reason: "lease-unreadable" }
          : !target
            ? { kind: "not-found" }
            : settledCheck(target, request);
    const release = () => {
      if (lease.kind === "held") lease.release();
      admitted.release();
    };
    if (stop || !target) {
      release();
      return { ok: false, stop: stop ?? { kind: "not-found" } };
    }
    return { ok: true, held: admitted.held, target, release };
  }

  async function closeCase<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    slot: Extract<Slot, { kind: "close" }>,
  ): Promise<TransactionProof<Effect>> {
    const request = slot.request;
    const stop = (outcome: CloseResult) => {
      slot.outcome = outcome;
      return issuer.transactionProof(runId, unchangedObservation<Effect>([]));
    };
    const effect = declared.find((entry) => entry === request.effect);
    const problem = closeRequestProblem(request, effect);
    if (problem || !effect)
      return stop(problem ?? { kind: "unavailable", reason: "declaration" });
    const first = readTarget(request.operationId);
    if (first === "not-found") return stop({ kind: "not-found" });
    if (first === "corrupt")
      return stop({ kind: "unavailable", reason: "store-corrupt" });
    const early = settledCheck(first, request);
    if (early) return stop(early);
    const targetKeys = currentKeys(first.intent.scope);
    const admitted = await admitClosure(request, targetKeys);
    if (!admitted.ok) return stop(admitted.stop);
    const decision = await closureDecision(admitted.target, request, runId);
    if (!("closureId" in decision)) {
      admitted.release();
      return stop(decision);
    }
    const caseKey = `case:${request.operationId}`;
    const opened = await open(
      runId,
      {
        commandIdentity: request.command,
        effects: [effect],
        scope: {
          resources: [
            { resource: caseKey, key: caseKey, keys: [`key:${caseKey}`] },
          ],
          invariants: [],
          unknown: false,
          keys: [...new Set([...(targetKeys ?? []), `key:${caseKey}`])].sort(),
        },
        revisions: { [caseKey]: admitted.target.revision },
        facts: { closes: request.operationId, closureId: request.closureId },
        approval: null,
        closes: request.operationId,
        coordination: admitted.held.order,
      },
      admitted.held,
    );
    if (!opened) {
      admitted.release();
      return stop({ kind: "unavailable", reason: "store-publication" });
    }
    const { observation } = await runRecorded(
      issuer,
      runId,
      declared,
      opened.events,
      (transaction) =>
        transaction
          .record(
            effect,
            () =>
              publishClosure(paths, decision, () => phase("closure-staged")),
            () => Promise.resolve(closureMatches(paths, decision, runId)),
          )
          .then(() => undefined),
    );
    admitted.release();
    opened.releaseLease();
    slot.outcome =
      observation.transactionState === "completed"
        ? {
            kind: "closed",
            closure: decision,
            recoveryOperationId: opened.operationId,
          }
        : { kind: "recovery-failed", recoveryOperationId: opened.operationId };
    return issuer.transactionProof(runId, observation);
  }

  function readTarget(id: string): Operation | "not-found" | "corrupt" {
    try {
      return readOperation(paths, id);
    } catch {
      return "not-found";
    }
  }

  async function transaction<Effect extends string>(
    capability: StateCapability<Effect>,
    declaration: Declaration,
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
  ): Promise<TransactionOutcome<Effect>> {
    const marker = (inner: EffectTransaction<Effect>) => work(inner);
    const slot: Slot = { kind: "transaction", declaration };
    slots.set(marker, slot);
    const proof = await capability.transaction(marker);
    const outcome = slot.outcome;
    if (!outcome) throw new Error("The transaction did not report an outcome.");
    return { ...outcome, proof };
  }

  async function close<Effect extends string>(
    capability: StateCapability<Effect>,
    request: CloseRequest<Effect>,
  ): Promise<CloseOutcome<Effect>> {
    const marker = () => Promise.resolve();
    const slot: Slot = { kind: "close", request };
    slots.set(marker, slot);
    const proof = await capability.transaction(marker);
    const outcome = slot.outcome;
    if (!outcome) throw new Error("The closure did not report an outcome.");
    return { ...outcome, proof };
  }

  // DISC-14: read-only; reads files only, takes no coordination lock.
  function report(): ReportResult {
    const store = readStore(paths);
    if (!store.ok) return store;
    return {
      ok: true,
      unfinished: store.operations
        .filter((operation) => operation.status === "unresolved")
        .map((operation) => ({
          operationId: operation.intent.operationId,
          commandIdentity: operation.intent.commandIdentity,
          runId: operation.intent.runId,
          effects: [...operation.intent.effects],
        })),
    };
  }

  // REC-6: read-only case history. Observers are read-only host reads.
  async function history(operationId: string): Promise<HistoryResult> {
    if (!operationPattern.test(operationId))
      return { ok: false, reason: "not-found" };
    const store = readStore(paths);
    if (!store.ok) return store;
    const operation = store.operations.find(
      (entry) => entry.intent.operationId === operationId,
    );
    if (!operation) return { ok: false, reason: "not-found" };
    const intent = operation.intent;
    const closure = operation.closure;
    return {
      ok: true,
      history: {
        operationId,
        commandIdentity: intent.commandIdentity,
        runId: intent.runId,
        effects: [...intent.effects],
        status: operation.status,
        scope: {
          resources: intent.scope.resources.map((item) => ({
            resource: item.resource,
            keys: [...item.keys],
          })),
          invariants: [...intent.scope.invariants],
          unknown: intent.scope.unknown,
        },
        revisions: { ...intent.revisions },
        approvalReference: intent.approval?.reference ?? null,
        closes: intent.closes,
        journal: {
          revision: operation.revision,
          events: operation.events.map((event) => ({
            kind: event.kind,
            effect: event.effect ?? null,
          })),
          tornTail: operation.tornTail,
        },
        observed: await classify(operation, observers, paths),
        closure: closure
          ? {
              closureId: closure.closureId,
              disposition: closure.disposition,
              reason: closure.reason,
              journalRevision: closure.journalRevision,
              qualification: closure.qualification,
              evidence: closure.evidence.map((item) => ({ ...item })),
            }
          : null,
        closureDamaged: operation.closureDamaged,
      },
    };
  }

  // LIFE-6a: one bounded synchronous attempt; never throws.
  function emergencyRecord(facts: EmergencyFacts): void {
    const run = active.get(facts.runId);
    if (!run || run.emergencyWritten) return;
    run.emergencyWritten = true;
    try {
      appendEvent(run.events, "emergency", { phase: facts.phase });
    } catch {
      // One attempt only.
    }
  }

  function capabilities(): CapabilityReport {
    const qualification = resolveQualification(options.qualification);
    const coordination = coordinationAvailable() ? "available" : "unavailable";
    const stopped =
      coordination === "available" &&
      qualification.stoppedOwner !== "unavailable"
        ? "available"
        : "unavailable";
    return {
      qualification: qualification.label,
      coordination,
      stoppedOwnerProof: stopped,
      automaticReclaim: "unavailable",
      humanAssistedTakeover: "unavailable",
      humanOutcomeUnknownClosure: "unavailable",
      reasons: [
        ...(coordination === "unavailable"
          ? ["No qualified coordination primitive on this platform."]
          : []),
        ...(stopped === "unavailable"
          ? [
              "No reviewed qualification row for the stopped-owner condition (REC-7b).",
            ]
          : []),
        "Reclaim grants coordination only and has no separate step (REC-7).",
        "Human-assisted takeover needs a reviewed row and a qualified authority source (REC-7a).",
        "Human outcome-unknown closure needs a qualified authority source (REC-5).",
      ],
    };
  }

  return Object.freeze({
    descriptor,
    emergencyRecord,
    transaction,
    close,
    report,
    history,
    capabilities,
  });
}

function settled(lifetime: {
  inflight: number;
  wake: () => void;
}): Promise<void> {
  if (lifetime.inflight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    lifetime.wake = resolve;
  });
}
