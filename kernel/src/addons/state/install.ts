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
import { waitLock } from "./coordination.ts";
import type { CoordinationRoute, LockAttempt } from "./coordination.ts";
import type { CapabilityReport, Qualification } from "./qualification.ts";
import { canonicalise, conflicts, currentKeys } from "./scope.ts";
import type { CanonicalScope, ScopeDeclaration } from "./scope.ts";
import {
  appendDelegateStart,
  appendEvent,
  delegateBoot,
  ensureStore,
  flushMoves,
  layout,
  moveSettledCase,
  operationPattern,
  publishClosure,
  publishOperation,
  readCase,
  readClosure,
  readStore,
  settledIsPrivate,
  storeProblem,
  upgradeStore,
} from "./store.ts";
import type {
  Closure,
  Disposition,
  Intent,
  Layout,
  Operation,
  UpgradePhase,
} from "./store.ts";

export type { ScopeDeclaration } from "./scope.ts";
export type { Disposition } from "./store.ts";

// Interface: Independent resource evidence for recovery (DESIGN.md section 8). A host
// observer is read-only. `excluded` means host evidence rules out that the
// attempted effect ever happened; `absent` is current absence only.
export type Observation = "present" | "excluded" | "absent" | "unobservable";
export type Observer = (input: {
  readonly effect: string;
  readonly operationId: string;
  readonly facts: unknown;
  readonly revisions: Readonly<Record<string, string>>;
}) => Promise<Observation>;

export type Phase =
  | "admission-wait"
  | "staged"
  | "closure-staged"
  | "closure-read"
  | UpgradePhase;

export type StateOptions = {
  readonly root: string;
  readonly report: string;
  readonly observers?: Readonly<Record<string, Observer>>;
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
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly detail?: string;
    };

// Interface: What the work function learns about its published operation before any
// effect runs. `operationId` is the identity an Observer is later handed, so a
// host can label an outside object with it and find that label as evidence.
export type PublishedOperation = { readonly operationId: string };

export type TransactionResult<Effect extends string> = {
  readonly proof: TransactionProof<Effect>;
} & (
  | {
      readonly kind: "ran";
      readonly operationId: string;
      readonly workFailed: boolean;
    }
  | Refusal
);

export type CloseRequest<Effect extends string> = {
  readonly command: string;
  readonly effect: Effect;
  readonly operationId: string;
  readonly closureId: string;
  readonly disposition: Disposition;
  readonly revision: string;
  readonly reason: string;
  readonly attestation?: boolean;
};

export type CloseResult<Effect extends string> = {
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
      operationId?: string;
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
      outcome?: CloseResultBody;
    };
type CloseResultBody =
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

type InFlight = { count: number; wake: () => void };

type Recording<Effect extends string> = {
  ended: boolean;
  readonly records: InFlight;
  readonly started: Effect[];
  readonly confirmed: Effect[];
};

type TransactionHold = {
  readonly events: string;
  readonly releaseKeyLocks: () => void;
  readonly releaseLease: () => void;
};

function endedRefusal(call: "record" | "admitStart"): Error {
  return new Error(
    `The transaction ended when its work function returned or threw, so ${call} refuses. Await every record inside the work function.`,
  );
}

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

function settledCheck(
  operation: Operation,
  request: CloseRequest<string>,
): CloseResultBody | undefined {
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

function readProblem(
  read: "not-found" | "corrupt" | "unreadable",
): CloseResultBody {
  return read === "not-found"
    ? { kind: "not-found" }
    : { kind: "unavailable", reason: `store-${read}` };
}

// Accepted decisions (Nathan, 19 November 2026; journal version 2 design part
// 2 sections 4 and 5): a torn tail alone does not refuse, because a free lease
// means no append can follow (L, 13:46), unless a record hides inside it
// (16:29). A case whose run started a program closes only after the container
// machine restarts (K, 12:08): every delegate-admitted must name a boot other
// than the current one; no boot, or the same boot, refuses.
export function stoppedOwnerProblem(
  target: Operation,
  boot: string | undefined,
): string | undefined {
  if (target.recordHiddenInTornTail) return "journal-torn";
  const delegateMayRun = target.events.some((event) => {
    if (event.kind !== "delegate-admitted") return false;
    const started = delegateBoot(event);
    return started === undefined || boot === undefined || started === boot;
  });
  return delegateMayRun ? "delegate-recorded" : undefined;
}

function caseRead(
  paths: Locked,
  request: CloseRequest<string>,
):
  | { readonly ok: false; readonly stop: CloseResultBody }
  | { readonly ok: true; readonly target: Operation } {
  const read = readCase(paths, request.operationId);
  if (typeof read === "string") return { ok: false, stop: readProblem(read) };
  const stop = settledCheck(read, request);
  return stop ? { ok: false, stop } : { ok: true, target: read };
}

// Accepted decision (Nathan, 19 November 2026, 17:43 AEDT): the closer
// reads the case again once it holds the owner lease and decides only on
// that read, which no owner can append to, and refuses when it differs
// from the revision the request names.
function caseUnderLease(
  paths: Locked,
  request: CloseRequest<string>,
):
  | { readonly ok: false; readonly stop: CloseResultBody }
  | {
      readonly ok: true;
      readonly target: Operation;
      readonly release: () => void;
    } {
  const id = request.operationId;
  const lease = paths.tryLock(join(paths.operation(id), "owner.lease"), false);
  if (lease.kind === "busy") return { ok: false, stop: { kind: "owner-live" } };
  if (lease.kind === "failed")
    return {
      ok: false,
      stop: { kind: "unavailable", reason: "lease-unreadable" },
    };
  const read = caseRead(paths, request);
  if (read.ok && read.target.revision === request.revision)
    return { ok: true, target: read.target, release: lease.release };
  lease.release();
  return { ok: false, stop: read.ok ? { kind: "stale-revision" } : read.stop };
}

function closureMatches(
  paths: Layout,
  closure: Closure,
  runId: string,
): boolean {
  const written = readClosure(paths, closure.operationId);
  if (written === "unreadable") throw new Error("The closure cannot be read.");
  return (
    typeof written === "object" &&
    written.closureId === closure.closureId &&
    written.recoveryRunId === runId
  );
}

function closureObservation(paths: Layout, operation: Operation): Observation {
  const target = operation.intent.closes;
  if (target === null) return "unobservable";
  const written = readClosure(paths, target);
  if (typeof written === "string") return "unobservable";
  if (written === undefined) return "absent";
  return written.recoveryRunId === operation.intent.runId
    ? "present"
    : "excluded";
}

type Held = { readonly release: () => void };

type Locked = Layout & {
  readonly tryLock: (path: string, create?: boolean) => LockAttempt;
};

async function acquire(
  paths: Locked,
  keys: readonly string[],
  boundMilliseconds: number,
  beforeWait: () => Promise<void>,
): Promise<
  | {
      readonly ok: true;
      readonly admission: Held;
      readonly keys: Held;
      readonly order: readonly string[];
    }
  | { readonly ok: false; readonly refusal: Refusal }
> {
  await beforeWait();
  const admission = await waitLock(
    paths.tryLock,
    paths.admission,
    boundMilliseconds,
  );
  if (admission.kind === "busy")
    return { ok: false, refusal: { kind: "busy" } };
  if (admission.kind === "failed")
    return {
      ok: false,
      refusal: {
        kind: "unavailable",
        reason: "coordination-failed",
        detail: `admission.lock: ${admission.code}`,
      },
    };
  const files = [...new Set(keys.map(paths.keyLock))].sort();
  const held: (() => void)[] = [];
  const releaseKeys = () => {
    for (const release of held.reverse()) release();
    held.length = 0;
  };
  for (const file of files) {
    const attempt = paths.tryLock(file);
    if (attempt.kind === "held") {
      held.push(attempt.release);
      continue;
    }
    releaseKeys();
    const owner = attempt.kind === "busy" ? liveHolder(paths, keys) : undefined;
    admission.release();
    return {
      ok: false,
      refusal:
        attempt.kind === "failed"
          ? {
              kind: "unavailable",
              reason: "coordination-failed",
              detail: `${file.slice(file.lastIndexOf("/") + 1)}: ${attempt.code}`,
            }
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

function liveHolder(
  paths: Locked,
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

function liveClosers(
  paths: Locked,
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

function probeLease(paths: Locked, id: string): "live" | "free" {
  const attempt = paths.tryLock(
    join(paths.operation(id), "owner.lease"),
    false,
  );
  if (attempt.kind === "held") {
    attempt.release();
    return "free";
  }
  return attempt.kind === "busy" ? "live" : "free";
}

function blocking(
  paths: Locked,
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

export type Seams = {
  readonly qualification: Qualification;
  readonly phase: (name: Phase) => Promise<void>;
  readonly coordination: CoordinationRoute;
  readonly moverStart?: (candidates: number) => number;
  readonly moverReport?: (examined: number, moved: number) => void;
};

// Accepted decision (Nathan, 19 November 2026, 12:08 AEDT; journal version 2
// design, decision F): at most 64 moves per hold of the admission lock. The
// design sets 128 examined cases per hold, so each cap is observable alone.
const moveBound = 64;
const examineBound = 128;

function randomStart(candidates: number): number {
  return Math.floor(Math.random() * candidates);
}

export function install(options: StateOptions, seams: Seams) {
  // Platform: Checked before anything else: Math.max and Math.min pass NaN through,
  // and a NaN bound never ends the wait for the admission lock.
  const wait: unknown = options.admissionWaitMilliseconds;
  if (wait !== undefined && (typeof wait !== "number" || Number.isNaN(wait)))
    throw new TypeError(
      "The state add-on factory option admissionWaitMilliseconds must be a number of milliseconds, or left unset for the default of 2000.",
    );
  const route = seams.coordination;
  const paths: Locked = {
    ...layout(options.root),
    tryLock: route.available
      ? route.tryLock
      : () => {
          throw new Error("Coordination route unavailable.");
        },
  };
  const observers = options.observers ?? {};
  const rowMatch = () =>
    seams.qualification.match(
      paths.root,
      route.available ? route.route : undefined,
    );
  const phase = seams.phase;
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
    if (!route.available)
      return refuse({
        kind: "unavailable",
        reason: route.reason,
        detail: route.detail,
      });
    if (!ensureStore(paths))
      return refuse({ kind: "unavailable", reason: "store" });
    return slot.kind === "transaction"
      ? transact(issuer, runId, declared, work, slot, refuse)
      : closeCase(issuer, runId, declared, slot);
  }

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
        const attempt = paths.tryLock(lease);
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
    const held = await acquire(paths, lockKeys, bound, () =>
      phase("admission-wait"),
    );
    if (!held.ok) return held;
    let current = true;
    const release = () => {
      current = false;
      held.keys.release();
      held.admission.release();
    };
    const upgradeProblem = await upgradeStore(paths, phase);
    const store = readStore(paths);
    const refusal: Refusal | undefined = upgradeProblem
      ? { kind: "unavailable", reason: upgradeProblem }
      : !store.ok
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
      const { consumed } = await runtime.revalidateAndConsume(
        request,
        coordination,
      );
      return consumed
        ? { kind: "preview", reference: request.preview }
        : { kind: "denied" };
    } catch (error) {
      return rejectionConsumed(error) === true
        ? { kind: "approval-lost" }
        : { kind: "approval-unavailable" };
    }
  }

  async function open(
    runId: string,
    intent: Omit<Intent, "operationId" | "runId" | "owner">,
    admitted: {
      readonly held: Acquired;
      readonly operations: readonly Operation[];
    },
  ) {
    let opened: Awaited<ReturnType<typeof begin>>;
    try {
      opened = await begin(runId, intent);
    } catch {
      opened = undefined;
    }
    if (opened) moveSettled(admitted.operations);
    admitted.held.admission.release();
    return opened;
  }

  function moveSettled(read: readonly Operation[]): void {
    const candidates = read.filter(
      (operation) => operation.status !== "unresolved",
    );
    const tally = { examined: 0, moved: 0 };
    const examinable = settledIsPrivate(paths)
      ? Math.min(candidates.length, examineBound)
      : 0;
    try {
      const start =
        examinable === 0
          ? 0
          : (seams.moverStart ?? randomStart)(candidates.length) %
            candidates.length;
      while (tally.examined < examinable && tally.moved < moveBound) {
        const candidate =
          candidates[(start + tally.examined) % candidates.length];
        tally.examined += 1;
        if (
          candidate &&
          movable(candidate) &&
          moveSettledCase(paths, candidate.intent.operationId) === "moved"
        )
          tally.moved += 1;
      }
    } catch {
      return;
    } finally {
      flushMoved(tally.moved);
      reportMoves(tally);
    }
  }

  function movable(candidate: Operation): boolean {
    const id = candidate.intent.operationId;
    return (
      !candidate.closureDamaged &&
      lockFree(join(paths.operation(id), "owner.lease"), false) &&
      lockFree(paths.keyLock(`case:${id}`), true)
    );
  }

  function lockFree(path: string, absentIsFree: boolean): boolean {
    const attempt = paths.tryLock(path, false);
    if (attempt.kind === "held") {
      attempt.release();
      return true;
    }
    return (
      absentIsFree && attempt.kind === "failed" && attempt.code === "ENOENT"
    );
  }

  function reportMoves(tally: {
    readonly examined: number;
    readonly moved: number;
  }): void {
    try {
      seams.moverReport?.(tally.examined, tally.moved);
    } catch {
      return;
    }
  }

  function flushMoved(moved: number): void {
    if (moved === 0) return;
    try {
      flushMoves(paths);
    } catch {
      return;
    }
  }

  // Accepted decision (Nathan, 19 November 2026, 13:46 AEDT; journal version 2
  // design, open point X): a transaction waits for its started effects with no
  // time limit. A record that never settles keeps the lease until it settles or
  // the process ends; runProcess ends the process at a run's deadline.
  async function runRecorded<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    held: TransactionHold,
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
  ) {
    const recording: Recording<Effect> = {
      ended: false,
      records: { count: 0, wake: () => {} },
      started: [],
      confirmed: [],
    };
    let workFailed = false;
    try {
      await work(recorder(issuer, runId, declared, held.events, recording));
    } catch {
      workFailed = true;
    }
    recording.ended = true;
    await settled(recording.records);
    const observation = observationOf(
      declared,
      recording.confirmed,
      recording.started,
    );
    finish(held.events, observation);
    active.delete(runId);
    held.releaseKeyLocks();
    held.releaseLease();
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
      admitted,
    );
    if (!opened) {
      admitted.release();
      return refuse({ kind: "unavailable", reason: "store-publication" });
    }
    slot.operationId = opened.operationId;
    const { observation, workFailed } = await runRecorded(
      issuer,
      runId,
      declared,
      {
        events: opened.events,
        releaseKeyLocks: admitted.release,
        releaseLease: opened.releaseLease,
      },
      work,
    );
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
      return;
    }
  }

  function recorder<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    events: string,
    recording: Recording<Effect>,
  ): EffectTransaction<Effect> {
    const { started, confirmed } = recording;
    const unguarded: EffectTransaction<Effect> = {
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
          readonly starts: InFlight;
        } = { state: "active", starts: { count: 0, wake: () => {} } };
        const admitStart = <R>(
          startRun: string,
          startEffect: Effect,
          start: () => Promise<R>,
        ): Promise<R> => {
          if (recording.ended)
            return Promise.reject(endedRefusal("admitStart"));
          if (
            startRun !== runId ||
            startEffect !== effect ||
            lifetime.state !== "active"
          )
            return Promise.reject(
              new Error("The recorded effect is not active for this run."),
            );
          try {
            appendDelegateStart(
              events,
              effect,
              seams.qualification.bootIdentity(),
            );
          } catch (error) {
            return Promise.reject(
              error instanceof Error
                ? error
                : new Error("delegate record failed"),
            );
          }
          let pending: Promise<R>;
          try {
            pending = start();
          } catch (error) {
            pending = Promise.reject(
              error instanceof Error ? error : new Error("start failed"),
            );
          }
          return tracked(lifetime.starts, pending);
        };
        const capability = issuer.recordedEffect(runId, effect, admitStart);
        let result: T;
        try {
          result = await operation(capability);
        } catch (error) {
          lifetime.state = "closing";
          await settled(lifetime.starts);
          appendEvent(events, "effect-unconfirmed", {
            effect,
            reason: "operation-failed",
          });
          throw error;
        }
        lifetime.state = "closing";
        await settled(lifetime.starts);
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
    return {
      record(effect, operation, readBack) {
        if (recording.ended) return Promise.reject(endedRefusal("record"));
        return tracked(
          recording.records,
          unguarded.record(effect, operation, readBack),
        );
      },
    };
  }

  async function closureDecision(
    target: Operation,
    request: CloseRequest<string>,
    runId: string,
  ): Promise<CloseResultBody | Closure> {
    const match = rowMatch();
    if (!match.matched)
      return {
        kind: "unavailable",
        reason: "stopped-owner-proof-unqualified",
        detail: match.detail,
      };
    const reason = stoppedOwnerProblem(target, match.bootIdentity);
    if (reason) return { kind: "unavailable", reason };
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
      qualification: match.label,
      recoveryRunId: runId,
    };
  }

  async function admitClosure(
    request: CloseRequest<string>,
    targetKeys: readonly string[] | undefined,
  ): Promise<
    | { readonly ok: false; readonly stop: CloseResultBody }
    | {
        readonly ok: true;
        readonly held: Acquired;
        readonly operations: readonly Operation[];
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
    const target = admitted.operations.find(
      (operation) => operation.intent.operationId === id,
    );
    if (!target) {
      admitted.release();
      const moved = caseRead(paths, request);
      return { ok: false, stop: moved.ok ? { kind: "not-found" } : moved.stop };
    }
    await phase("closure-read");
    const leased = caseUnderLease(paths, request);
    if (!leased.ok) {
      admitted.release();
      return leased;
    }
    return {
      ok: true,
      held: admitted.held,
      operations: admitted.operations,
      target: leased.target,
      release: () => {
        leased.release();
        admitted.release();
      },
    };
  }

  async function closeCase<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    slot: Extract<Slot, { kind: "close" }>,
  ): Promise<TransactionProof<Effect>> {
    const request = slot.request;
    const stop = (outcome: CloseResultBody) => {
      slot.outcome = outcome;
      return issuer.transactionProof(runId, unchangedObservation<Effect>([]));
    };
    const effect = declared.find((entry) => entry === request.effect);
    const problem = closeRequestProblem(request, effect);
    if (problem || !effect)
      return stop(problem ?? { kind: "unavailable", reason: "declaration" });
    const first = caseRead(paths, request);
    if (!first.ok) return stop(first.stop);
    const targetKeys = currentKeys(first.target.intent.scope);
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
      admitted,
    );
    if (!opened) {
      admitted.release();
      return stop({ kind: "unavailable", reason: "store-publication" });
    }
    const { observation } = await runRecorded(
      issuer,
      runId,
      declared,
      {
        events: opened.events,
        releaseKeyLocks: admitted.release,
        releaseLease: opened.releaseLease,
      },
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

  async function transaction<Effect extends string>(
    capability: StateCapability<Effect>,
    declaration: Declaration,
    work: (
      transaction: EffectTransaction<Effect>,
      published: PublishedOperation,
    ) => Promise<void>,
  ): Promise<TransactionResult<Effect>> {
    const slot: Extract<Slot, { kind: "transaction" }> = {
      kind: "transaction",
      declaration,
    };
    const marker = (inner: EffectTransaction<Effect>) =>
      slot.operationId === undefined
        ? Promise.reject(
            new Error(
              "Work runs only after the state add-on publishes its operation.",
            ),
          )
        : work(inner, Object.freeze({ operationId: slot.operationId }));
    slots.set(marker, slot);
    const proof = await capability.transaction(marker);
    const outcome = slot.outcome;
    if (!outcome) throw new Error("The transaction did not report a result.");
    return { ...outcome, proof };
  }

  async function close<Effect extends string>(
    capability: StateCapability<Effect>,
    request: CloseRequest<Effect>,
  ): Promise<CloseResult<Effect>> {
    const marker = () => Promise.resolve();
    const slot: Slot = { kind: "close", request };
    slots.set(marker, slot);
    const proof = await capability.transaction(marker);
    const outcome = slot.outcome;
    if (!outcome) throw new Error("The closure did not report a result.");
    return { ...outcome, proof };
  }

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

  async function history(operationId: string): Promise<HistoryResult> {
    if (!operationPattern.test(operationId))
      return { ok: false, reason: "not-found" };
    const problem = storeProblem(paths);
    if (problem) return { ok: false, reason: problem };
    const operation = readCase(paths, operationId);
    if (typeof operation === "string") return { ok: false, reason: operation };
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

  function emergencyRecord(facts: EmergencyFacts): void {
    const run = active.get(facts.runId);
    if (!run || run.emergencyWritten) return;
    run.emergencyWritten = true;
    try {
      appendEvent(run.events, "emergency", { phase: facts.phase });
    } catch {
      return;
    }
  }

  function capabilities(): CapabilityReport {
    const match = rowMatch();
    const coordination = route.available ? "available" : "unavailable";
    const stopped =
      coordination === "unavailable" || !match.matched
        ? "unavailable"
        : seams.qualification.source === "fixture"
          ? "fixture-only"
          : "available";
    return {
      qualification: match.matched ? match.label : "unqualified",
      coordination,
      coordinationRoute: route.available
        ? route.basis
        : `${route.reason}: ${route.detail}`,
      stoppedOwnerProof: stopped,
      automaticReclaim: "unavailable",
      humanAssistedTakeover: "unavailable",
      humanOutcomeUnknownClosure: "unavailable",
      reasons: [
        ...(route.available
          ? []
          : [`Coordination unavailable (${route.reason}): ${route.detail}.`]),
        ...(stopped === "fixture-only"
          ? [
              "The stopped-owner condition is enabled only by a labelled test fixture; it never enables production closure.",
            ]
          : []),
        ...(stopped === "unavailable"
          ? [
              "No reviewed capability qualification row for the stopped-owner condition (REC-7b).",
              ...(match.matched ? [] : [`${match.detail}.`]),
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

function tracked<R>(inFlight: InFlight, pending: Promise<R>): Promise<R> {
  inFlight.count += 1;
  return pending.finally(() => {
    inFlight.count -= 1;
    if (inFlight.count === 0) inFlight.wake();
  });
}

function settled(inFlight: InFlight): Promise<void> {
  if (inFlight.count === 0) return Promise.resolve();
  return new Promise((resolve) => {
    inFlight.wake = resolve;
  });
}
