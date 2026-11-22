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
import {
  canonicalise,
  canonicalisePlain,
  conflicts,
  coversDeclaredResources,
  createOnceReader,
  currentKeys,
  readPlainScope,
  readPlainStrings,
} from "./scope.ts";
import type { CanonicalScope, OnceReader, ScopeDeclaration } from "./scope.ts";
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
  | "closure-published"
  | UpgradePhase;

export type StateOptions = {
  readonly root: string;
  readonly report: string;
  readonly observers?: Readonly<Record<string, Observer>>;
  readonly admissionWaitMilliseconds?: number;
};

export const supersededQualification = "superseded-owner-lease-free";
export const supersedeFilesystemReason = "supersede-filesystem-unsupported";

export type Declaration = {
  readonly command: string;
  readonly scope: ScopeDeclaration;
  readonly revisions?: Readonly<Record<string, string>>;
  readonly facts?: unknown;
  // Interface: Opt-in declaration that this changing command is safe to run
  // again even alongside a leftover copy of the program an earlier run started.
  // An effect that creates something new is safe to repeat only if its name or
  // key comes from the inputs, not from the fresh operationId; a request the
  // earlier run already sent can still land after the new run's, so only the
  // remote side can deduplicate it with an input-derived key.
  readonly supersedeUnresolved?: boolean;
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
// `superseded`, when present, lists the earlier operation ids closed by this run.
export type PublishedOperation = {
  readonly operationId: string;
  readonly superseded?: readonly string[];
};

export type TransactionResult<Effect extends string> = {
  readonly proof: TransactionProof<Effect>;
} & (
  | {
      readonly kind: "ran";
      readonly operationId: string;
      readonly workFailed: boolean;
      readonly superseded?: readonly string[];
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
      superseded?: readonly string[];
      outcome?:
        | Refusal
        | {
            readonly kind: "ran";
            readonly operationId: string;
            readonly workFailed: boolean;
            readonly superseded?: readonly string[];
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
  const stop: CloseResultBody | undefined =
    read.revision === request.revision
      ? settledCheck(read, request)
      : { kind: "stale-revision" };
  return stop ? { ok: false, stop } : { ok: true, target: read };
}

// Accepted decision (Nathan, 19 November 2026, 17:43 AEDT): the closer
// reads the case again once it holds the owner lease and decides only on
// that read, which no owner can append to, and refuses when it differs
// from the revision the request names.
async function acquireTargetLease(
  owner: LockOwner,
  paths: Locked,
  operationId: string,
  beforeLease: () => Promise<void>,
): Promise<
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly kind: "busy" | "failed" }
> {
  await beforeLease();
  const attempt = paths.tryLock(
    join(paths.operation(operationId), "owner.lease"),
    false,
  );
  switch (attempt.kind) {
    case "held":
      return { ok: true, release: owner.holdTargetLease(attempt.release) };
    case "busy":
      return { ok: false, kind: "busy" };
    case "failed":
      return { ok: false, kind: "failed" };
  }
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

type Locked = Layout & {
  readonly tryLock: (path: string, create?: boolean) => LockAttempt;
};

type LockOwner = {
  readonly isActive: () => boolean;
  readonly holdAdmission: (release: () => void) => void;
  readonly releaseAdmission: () => void;
  readonly holdKeyLock: (release: () => void) => void;
  readonly releaseKeyLocks: () => void;
  readonly holdTargetLease: (release: () => void) => () => void;
  readonly holdRunLease: (release: () => void) => void;
  readonly transferToRun: () => {
    readonly releaseKeyLocks: () => void;
    readonly releaseLease: () => void;
  };
  readonly releaseAll: () => void;
};

function releaseEach(releases: readonly (() => void)[]): void {
  for (const release of releases) {
    try {
      release();
    } catch {
      continue;
    }
  }
}

function createLockOwner(): LockOwner {
  let active = true;
  let admission: (() => void) | undefined;
  let keyLocks: (() => void)[] = [];
  const targetLeases = new Set<() => void>();
  let runLease: (() => void) | undefined;

  const releaseAdmission = () => {
    const release = admission;
    admission = undefined;
    if (release) releaseEach([release]);
  };
  const releaseKeyLocks = () => {
    active = false;
    const held = keyLocks.splice(0).reverse();
    releaseEach(held);
  };
  const holdTargetLease = (release: () => void) => {
    targetLeases.add(release);
    return () => {
      if (!targetLeases.delete(release)) return;
      releaseEach([release]);
    };
  };
  const releaseAll = () => {
    active = false;
    const targets = [...targetLeases].reverse();
    targetLeases.clear();
    const lease = runLease;
    runLease = undefined;
    const keys = keyLocks.splice(0).reverse();
    const admit = admission;
    admission = undefined;
    releaseEach([
      ...targets,
      ...(lease ? [lease] : []),
      ...keys,
      ...(admit ? [admit] : []),
    ]);
  };
  const transferToRun = () => {
    const transferredKeys = keyLocks;
    keyLocks = [];
    const transferredTargets = [...targetLeases];
    targetLeases.clear();
    const transferredLease = runLease;
    runLease = undefined;
    return {
      releaseKeyLocks: () => {
        active = false;
        releaseEach([
          ...transferredTargets.reverse(),
          ...transferredKeys.reverse(),
        ]);
      },
      releaseLease: () => {
        if (transferredLease) releaseEach([transferredLease]);
      },
    };
  };
  return {
    isActive: () => active,
    holdAdmission: (release) => {
      admission = release;
    },
    releaseAdmission,
    holdKeyLock: (release) => {
      keyLocks.push(release);
    },
    releaseKeyLocks,
    holdTargetLease,
    holdRunLease: (release) => {
      runLease = release;
    },
    transferToRun,
    releaseAll,
  };
}

async function acquireInto(
  owner: LockOwner,
  paths: Locked,
  keys: readonly string[],
  boundMilliseconds: number,
  beforeWait: () => Promise<void>,
): Promise<
  | { readonly ok: true; readonly order: readonly string[] }
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
  owner.holdAdmission(admission.release);
  const files = [...new Set(keys.map(paths.keyLock))].sort();
  for (const file of files) {
    const attempt = paths.tryLock(file);
    if (attempt.kind === "held") {
      owner.holdKeyLock(attempt.release);
      continue;
    }
    owner.releaseKeyLocks();
    const holder =
      attempt.kind === "busy" ? liveHolder(paths, keys) : undefined;
    return {
      ok: false,
      refusal:
        attempt.kind === "failed"
          ? {
              kind: "unavailable",
              reason: "coordination-failed",
              detail: `${file.slice(file.lastIndexOf("/") + 1)}: ${attempt.code}`,
            }
          : holder === undefined
            ? { kind: "busy" }
            : { kind: "held-lock", operationId: holder },
    };
  }
  return {
    ok: true,
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

type LeasedTarget = {
  readonly target: Operation;
  readonly release: () => void;
};

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
  try {
    const consumed: unknown = Reflect.get(error, "consumed");
    return typeof consumed === "boolean" ? consumed : undefined;
  } catch {
    return undefined;
  }
}

type ApprovalSnapshot = {
  readonly runtime: ApprovalRuntime;
  readonly request: ApprovalRequest;
  readonly resource: string;
  readonly preview: string | undefined;
};

type DeclarationSnapshot = {
  readonly command: string;
  readonly scope: CanonicalScope;
  readonly revisions: Readonly<Record<string, string>>;
  readonly facts: unknown;
  readonly approval: ApprovalSnapshot | undefined;
};

function ownProperty(source: object, key: string): unknown {
  return Object.hasOwn(source, key) ? Reflect.get(source, key) : undefined;
}

function isFlaggedDeclaration(declaration: Declaration): boolean {
  return (
    typeof declaration === "object" &&
    declaration !== null &&
    ownProperty(declaration, "supersedeUnresolved") === true
  );
}

const snapshotDepthLimit = 64;

type SnapshotState = {
  readonly reader: OnceReader;
  readonly visiting: Set<object>;
  readonly copies: Map<object, unknown>;
};

function snapshotArray(
  source: readonly unknown[],
  depth: number,
  state: SnapshotState,
): readonly unknown[] {
  const out: unknown[] = [];
  const length = state.reader.length(source);
  for (let index = 0; index < length; index += 1) {
    const copy = snapshotValue(
      state.reader.field(source, String(index)),
      depth + 1,
      state,
    );
    out.push(copy === undefined ? null : copy);
  }
  return Object.freeze(out);
}

function snapshotObject(
  source: object,
  depth: number,
  state: SnapshotState,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of state.reader.keys(source)) {
    const copy = snapshotValue(
      state.reader.field(source, key),
      depth + 1,
      state,
    );
    if (copy === undefined) continue;
    Object.defineProperty(out, key, {
      value: copy,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

function isPrimitiveJson(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function snapshotValue(
  value: unknown,
  depth: number,
  state: SnapshotState,
): unknown {
  if (isPrimitiveJson(value)) return value;
  if (
    typeof value !== "object" ||
    value === null ||
    depth > snapshotDepthLimit ||
    state.visiting.has(value)
  )
    return undefined;
  if (state.copies.has(value)) return state.copies.get(value);
  state.visiting.add(value);
  try {
    const copy = Array.isArray(value)
      ? snapshotArray(value, depth, state)
      : snapshotObject(value, depth, state);
    state.copies.set(value, copy);
    return copy;
  } finally {
    state.visiting.delete(value);
  }
}

function snapshotRevisions(
  raw: unknown,
  reader: OnceReader,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const out: Record<string, string> = {};
  for (const key of reader.keys(raw)) {
    const value = reader.field(raw, key);
    if (typeof value !== "string") return undefined;
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

function readOwnTyped<T extends object, K extends keyof T & string>(
  source: T,
  key: K,
  reader: OnceReader,
): T[K] | undefined {
  const present = Object.hasOwn(source, key);
  const value = present ? source[key] : undefined;
  reader.recordOwn(source, key, present, value);
  return value;
}

function snapshotApprovalRequest(
  rawRequest: ApprovalRequest,
  reader: OnceReader,
):
  | {
      readonly request: ApprovalRequest;
      readonly resource: string;
      readonly preview: string | undefined;
    }
  | undefined {
  const authority = readOwnTyped(rawRequest, "authority", reader);
  const resource = readOwnTyped(rawRequest, "resource", reader);
  const resourceRevision = readOwnTyped(rawRequest, "resourceRevision", reader);
  const effects = readPlainStrings(
    readOwnTyped(rawRequest, "effects", reader),
    reader,
  );
  const rawPreview = readOwnTyped(rawRequest, "preview", reader);
  if (
    typeof authority !== "string" ||
    typeof resource !== "string" ||
    typeof resourceRevision !== "string" ||
    effects === undefined
  )
    return undefined;
  const preview = typeof rawPreview === "string" ? rawPreview : undefined;
  const request: ApprovalRequest = Object.freeze({
    authority,
    resource,
    resourceRevision,
    effects,
    ...(preview === undefined ? {} : { preview }),
  });
  return { request, resource, preview };
}

function snapshotApproval(
  declaration: Declaration,
  reader: OnceReader,
): ApprovalSnapshot | undefined | "invalid" {
  const approval = readOwnTyped(declaration, "approval", reader);
  if (approval === undefined) return undefined;
  if (typeof approval !== "object" || approval === null) return "invalid";
  const runtime = readOwnTyped(approval, "runtime", reader);
  const rawRequest = readOwnTyped(approval, "request", reader);
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    typeof rawRequest !== "object" ||
    rawRequest === null
  )
    return "invalid";
  const parsed = snapshotApprovalRequest(rawRequest, reader);
  return parsed === undefined
    ? "invalid"
    : Object.freeze({ runtime, ...parsed });
}

function readFlaggedDeclaration(
  declaration: Declaration,
  commandIdentity: string,
): DeclarationSnapshot | undefined {
  if (commandIdentity.length === 0) return undefined;
  const reader = createOnceReader();
  reader.recordOwn(declaration, "supersedeUnresolved", true, true);
  const declaredCommand = reader.field(declaration, "command");
  if (typeof declaredCommand !== "string" || declaredCommand.length === 0)
    return undefined;
  const scopeEntry = reader.own(declaration, "scope");
  if (!scopeEntry.present) return undefined;
  const approval = snapshotApproval(declaration, reader);
  if (approval === "invalid") return undefined;
  const scope = canonicalisePlain(readPlainScope(scopeEntry.value, reader));
  const revisions = snapshotRevisions(
    reader.field(declaration, "revisions"),
    reader,
  );
  if (revisions === undefined) return undefined;
  const rawFacts = reader.field(declaration, "facts");
  const facts =
    rawFacts === undefined
      ? null
      : (snapshotValue(rawFacts, 0, {
          reader,
          visiting: new Set<object>([declaration]),
          copies: new Map<object, unknown>(),
        }) ?? null);
  return Object.freeze({
    command: commandIdentity,
    scope,
    revisions,
    facts,
    approval,
  });
}

function intentOf(
  snapshot: DeclarationSnapshot,
  declared: readonly string[],
  approval: Intent["approval"],
  coordination: readonly string[],
): Omit<Intent, "operationId" | "runId" | "owner"> {
  return {
    commandIdentity: snapshot.command,
    effects: [...new Set<string>(declared)].sort(),
    scope: snapshot.scope,
    revisions: snapshot.revisions,
    facts: snapshot.facts,
    approval,
    closes: null,
    coordination,
  };
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
        commandIdentity: string,
      ): StateCapability<Effect> {
        return {
          transaction: (work) =>
            run(issuer, runId, commandIdentity, effects, work),
        };
      },
    };
  });

  async function run<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    commandIdentity: string,
    declared: readonly Effect[],
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
  ): Promise<TransactionProof<Effect>> {
    const slot = slots.get(work);
    if (!slot)
      throw new Error(
        "Open state transactions through the state add-on's transaction() or close().",
      );
    slots.delete(work);
    const refuse = (refusal: Refusal): TransactionProof<Effect> => {
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
      ? transact(issuer, runId, commandIdentity, declared, work, slot, refuse)
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
        readonly order: readonly string[];
        readonly operations: readonly Operation[];
        readonly release: () => void;
        readonly releaseAdmission: () => void;
        readonly isActive: () => boolean;
      }
  > {
    const owner = createLockOwner();
    let kept = false;
    try {
      const held = await acquireInto(owner, paths, lockKeys, bound, () =>
        phase("admission-wait"),
      );
      if (!held.ok) return held;
      const upgradeProblem = await upgradeStore(paths, phase);
      const store = readStore(paths);
      const refusal: Refusal | undefined = upgradeProblem
        ? { kind: "unavailable", reason: upgradeProblem }
        : !store.ok
          ? { kind: "unavailable", reason: `store-${store.reason}` }
          : blocking(paths, store.operations, keys, check);
      if (refusal || !store.ok)
        return {
          ok: false,
          refusal: refusal ?? { kind: "unavailable", reason: "store" },
        };
      kept = true;
      return {
        ok: true,
        order: held.order,
        operations: store.operations,
        release: owner.releaseAll,
        releaseAdmission: owner.releaseAdmission,
        isActive: owner.isActive,
      };
    } finally {
      if (!kept) owner.releaseAll();
    }
  }

  async function consumeApprovalUnflagged(
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

  async function consumeFlaggedApproval(
    issuer: StateIssuer,
    runId: string,
    snapshot: DeclarationSnapshot,
    isActive: () => boolean,
  ): Promise<Refusal | Intent["approval"]> {
    const approval = snapshot.approval;
    if (!approval) return null;
    if (
      approval.preview === undefined ||
      !snapshot.scope.resources.some(
        (item) => item.resource === approval.resource,
      )
    )
      return { kind: "unavailable", reason: "approval-resource-undeclared" };
    const coordination = issuer.exclusiveScope(
      runId,
      approval.resource,
      isActive,
    );
    try {
      const { consumed } = await approval.runtime.revalidateAndConsume(
        approval.request,
        coordination,
      );
      return consumed
        ? { kind: "preview", reference: approval.preview }
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
      readonly releaseAdmission: () => void;
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
    admitted.releaseAdmission();
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
      return { observation, workFailed };
    } finally {
      active.delete(runId);
      held.releaseKeyLocks();
      held.releaseLease();
    }
  }

  async function scanFlaggedStore(keys: readonly string[] | undefined): Promise<
    | { readonly ok: false; readonly refusal: Refusal }
    | {
        readonly ok: true;
        readonly operations: readonly Operation[];
        readonly conflicting: readonly Operation[];
      }
  > {
    const upgradeProblem = await upgradeStore(paths, phase);
    if (upgradeProblem)
      return {
        ok: false,
        refusal: { kind: "unavailable", reason: upgradeProblem },
      };
    const store = readStore(paths);
    if (!store.ok)
      return {
        ok: false,
        refusal: { kind: "unavailable", reason: `store-${store.reason}` },
      };
    const conflicting = store.operations.filter(
      (operation) =>
        operation.status === "unresolved" &&
        conflicts(keys, currentKeys(operation.intent.scope)),
    );
    return { ok: true, operations: store.operations, conflicting };
  }

  function verifyTargetUnderLease(
    candidate: Operation,
    snapshot: DeclarationSnapshot,
  ):
    | { readonly ok: false; readonly refusal: Refusal }
    | { readonly ok: true; readonly target: Operation } {
    const id = candidate.intent.operationId;
    const fresh = readCase(paths, id);
    if (typeof fresh === "string")
      return {
        ok: false,
        refusal:
          fresh === "not-found"
            ? { kind: "unresolved-case", operationId: id }
            : { kind: "unavailable", reason: `store-${fresh}` },
      };
    const eligible =
      fresh.status === "unresolved" &&
      fresh.revision === candidate.revision &&
      !fresh.recordHiddenInTornTail &&
      !fresh.closureDamaged &&
      fresh.intent.commandIdentity === snapshot.command &&
      coversDeclaredResources(snapshot.scope, fresh.intent.scope);
    return eligible
      ? { ok: true, target: fresh }
      : { ok: false, refusal: { kind: "unresolved-case", operationId: id } };
  }

  async function leaseConflictingTargets(
    owner: LockOwner,
    conflicting: readonly Operation[],
    snapshot: DeclarationSnapshot,
  ): Promise<
    | { readonly ok: false; readonly refusal: Refusal }
    | { readonly ok: true; readonly targets: readonly LeasedTarget[] }
  > {
    if (conflicting.length === 0) return { ok: true, targets: [] };
    const fsCheck = seams.qualification.localFilesystem(
      paths.root,
      route.available ? route.route : undefined,
    );
    if (!fsCheck.allowed)
      return {
        ok: false,
        refusal: {
          kind: "unavailable",
          reason: supersedeFilesystemReason,
          detail: fsCheck.detail,
        },
      };
    const targets: LeasedTarget[] = [];
    for (const candidate of conflicting) {
      const id = candidate.intent.operationId;
      const leased = await acquireTargetLease(owner, paths, id, () =>
        phase("closure-read"),
      );
      if (!leased.ok)
        return {
          ok: false,
          refusal:
            leased.kind === "busy"
              ? { kind: "held-lock", operationId: id }
              : { kind: "unavailable", reason: "lease-unreadable" },
        };
      const verified = verifyTargetUnderLease(candidate, snapshot);
      if (!verified.ok) return verified;
      targets.push({ target: verified.target, release: leased.release });
    }
    return { ok: true, targets };
  }

  function supersededClosureFor(target: Operation, runId: string): Closure {
    return {
      operationId: target.intent.operationId,
      closureId: `superseded-${hex32().slice(0, 16)}`,
      disposition: "outcome-unknown",
      reason: "superseded by later run of the same command",
      evidence: [],
      authority: null,
      journalRevision: target.revision,
      qualification: supersededQualification,
      recoveryRunId: runId,
    };
  }

  async function publishOneSupersedeClosure(
    entry: LeasedTarget,
    runId: string,
    commitLink: (link: () => boolean) => void,
  ): Promise<Refusal | undefined> {
    const id = entry.target.intent.operationId;
    try {
      const published = await publishClosure(
        paths,
        supersededClosureFor(entry.target, runId),
        () => phase("closure-staged"),
        commitLink,
      );
      return published === "published"
        ? undefined
        : { kind: "unresolved-case", operationId: id };
    } catch {
      return { kind: "unavailable", reason: "closure-publication" };
    } finally {
      entry.release();
    }
  }

  function settleUnusedIntent(
    runId: string,
    events: string,
    declared: readonly string[],
  ): void {
    finish(events, unchangedObservation(declared));
    active.delete(runId);
  }

  function runOpenForSupersede(
    issuer: StateIssuer,
    runId: string,
    targets: readonly LeasedTarget[],
  ): boolean {
    const first = targets[0];
    if (!first) return true;
    try {
      issuer.superseded(runId, first.target.intent.operationId, () => false);
      return true;
    } catch {
      return false;
    }
  }

  async function publishSupersedeClosures(
    issuer: StateIssuer,
    runId: string,
    targets: readonly LeasedTarget[],
  ): Promise<
    | { readonly ok: false; readonly refusal: Refusal }
    | { readonly ok: true; readonly ids: readonly string[] }
  > {
    const ids: string[] = [];
    for (const entry of targets) {
      const id = entry.target.intent.operationId;
      const problem = await publishOneSupersedeClosure(entry, runId, (link) => {
        issuer.superseded(runId, id, () => {
          if (!link()) return false;
          ids.push(id);
          return true;
        });
      });
      if (problem) return { ok: false, refusal: problem };
      await phase("closure-published");
    }
    return { ok: true, ids };
  }

  async function openFlaggedTransaction(
    owner: LockOwner,
    issuer: StateIssuer,
    runId: string,
    declared: readonly string[],
    intent: Omit<Intent, "operationId" | "runId" | "owner">,
    operations: readonly Operation[],
    targets: readonly LeasedTarget[],
  ): Promise<
    | { readonly ok: false; readonly refusal: Refusal }
    | {
        readonly ok: true;
        readonly operationId: string;
        readonly events: string;
        readonly superseded: readonly string[] | undefined;
      }
  > {
    if (!runOpenForSupersede(issuer, runId, targets))
      return {
        ok: false,
        refusal: { kind: "unavailable", reason: "closure-publication" },
      };
    const opened = await begin(runId, intent).catch(() => undefined);
    if (!opened)
      return {
        ok: false,
        refusal: { kind: "unavailable", reason: "store-publication" },
      };
    owner.holdRunLease(opened.releaseLease);
    let closed: Awaited<ReturnType<typeof publishSupersedeClosures>>;
    try {
      closed = await publishSupersedeClosures(issuer, runId, targets);
    } catch (error) {
      settleUnusedIntent(runId, opened.events, declared);
      throw error;
    }
    if (!closed.ok) {
      settleUnusedIntent(runId, opened.events, declared);
      return closed;
    }
    const refreshed = closed.ids.length > 0 ? readStore(paths) : undefined;
    moveSettled(refreshed?.ok ? refreshed.operations : operations);
    owner.releaseAdmission();
    return {
      ok: true,
      operationId: opened.operationId,
      events: opened.events,
      superseded:
        closed.ids.length > 0
          ? Object.freeze([...closed.ids].sort())
          : undefined,
    };
  }

  async function transactUnflagged<Effect extends string>(
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
    const approval = await consumeApprovalUnflagged(
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
        coordination: admitted.order,
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

  async function admitAndOpenFlagged(
    owner: LockOwner,
    issuer: StateIssuer,
    runId: string,
    declared: readonly string[],
    snapshot: DeclarationSnapshot,
  ) {
    const keys = snapshot.scope.unknown ? undefined : snapshot.scope.keys;
    const acquired = await acquireInto(owner, paths, keys ?? [], bound, () =>
      phase("admission-wait"),
    );
    if (!acquired.ok) return acquired;
    const scanned = await scanFlaggedStore(keys);
    if (!scanned.ok) return scanned;
    const leased = await leaseConflictingTargets(
      owner,
      scanned.conflicting,
      snapshot,
    );
    if (!leased.ok) return leased;
    const approval = await consumeFlaggedApproval(
      issuer,
      runId,
      snapshot,
      owner.isActive,
    );
    if (approval !== null && approval.kind !== "preview")
      return { ok: false as const, refusal: approval };
    const intent = intentOf(snapshot, declared, approval, acquired.order);
    return openFlaggedTransaction(
      owner,
      issuer,
      runId,
      declared,
      intent,
      scanned.operations,
      leased.targets,
    );
  }

  async function transactFlagged<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    commandIdentity: string,
    declared: readonly Effect[],
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
    slot: Extract<Slot, { kind: "transaction" }>,
    refuse: (refusal: Refusal) => TransactionProof<Effect>,
  ): Promise<TransactionProof<Effect>> {
    if (declared.length === 0 || commandIdentity.length === 0)
      return refuse({ kind: "unavailable", reason: "declaration" });
    const snapshot = readFlaggedDeclaration(slot.declaration, commandIdentity);
    if (!snapshot)
      return refuse({ kind: "unavailable", reason: "declaration" });
    const owner = createLockOwner();
    try {
      const opened = await admitAndOpenFlagged(
        owner,
        issuer,
        runId,
        declared,
        snapshot,
      );
      if (!opened.ok) return refuse(opened.refusal);
      slot.operationId = opened.operationId;
      if (opened.superseded !== undefined) slot.superseded = opened.superseded;
      const transferred = owner.transferToRun();
      const { observation, workFailed } = await runRecorded(
        issuer,
        runId,
        declared,
        { events: opened.events, ...transferred },
        work,
      );
      slot.outcome = {
        kind: "ran",
        operationId: opened.operationId,
        workFailed,
        ...(opened.superseded === undefined
          ? {}
          : { superseded: opened.superseded }),
      };
      return issuer.transactionProof(runId, observation);
    } finally {
      owner.releaseAll();
    }
  }

  async function transact<Effect extends string>(
    issuer: StateIssuer,
    runId: string,
    commandIdentity: string,
    declared: readonly Effect[],
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
    slot: Extract<Slot, { kind: "transaction" }>,
    refuse: (refusal: Refusal) => TransactionProof<Effect>,
  ): Promise<TransactionProof<Effect>> {
    if (isFlaggedDeclaration(slot.declaration))
      return transactFlagged(
        issuer,
        runId,
        commandIdentity,
        declared,
        work,
        slot,
        refuse,
      );
    return transactUnflagged(issuer, runId, declared, work, slot, refuse);
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

  async function scanClosureStore(
    targetKeys: readonly string[] | undefined,
    id: string,
  ): Promise<
    | { readonly ok: false; readonly stop: CloseResultBody }
    | { readonly ok: true; readonly operations: readonly Operation[] }
  > {
    const upgradeProblem = await upgradeStore(paths, phase);
    if (upgradeProblem)
      return {
        ok: false,
        stop: { kind: "unavailable", reason: upgradeProblem },
      };
    const store = readStore(paths);
    if (!store.ok)
      return {
        ok: false,
        stop: { kind: "unavailable", reason: `store-${store.reason}` },
      };
    const refusal = blocking(paths, store.operations, targetKeys, {
      liveOnly: true,
      except: id,
    });
    return refusal
      ? { ok: false, stop: refusal }
      : { ok: true, operations: store.operations };
  }

  async function leaseClosureTarget(
    owner: LockOwner,
    request: CloseRequest<string>,
    operations: readonly Operation[],
  ): Promise<
    | { readonly ok: false; readonly stop: CloseResultBody }
    | { readonly ok: true; readonly target: Operation }
  > {
    const id = request.operationId;
    const found = operations.find(
      (operation) => operation.intent.operationId === id,
    );
    if (!found) {
      const moved = caseRead(paths, request);
      return { ok: false, stop: moved.ok ? { kind: "not-found" } : moved.stop };
    }
    const leased = await acquireTargetLease(owner, paths, id, () =>
      phase("closure-read"),
    );
    if (!leased.ok)
      return {
        ok: false,
        stop:
          leased.kind === "busy"
            ? { kind: "owner-live" }
            : { kind: "unavailable", reason: "lease-unreadable" },
      };
    return caseRead(paths, request);
  }

  async function admitClosure(
    owner: LockOwner,
    request: CloseRequest<string>,
    targetKeys: readonly string[] | undefined,
  ): Promise<
    | { readonly ok: false; readonly stop: CloseResultBody }
    | {
        readonly ok: true;
        readonly order: readonly string[];
        readonly operations: readonly Operation[];
        readonly target: Operation;
      }
  > {
    const id = request.operationId;
    const acquired = await acquireInto(
      owner,
      paths,
      [...(targetKeys ?? []), `case:${id}`],
      bound,
      () => phase("admission-wait"),
    );
    if (!acquired.ok)
      return {
        ok: false,
        stop:
          acquired.refusal.kind === "held-lock" &&
          acquired.refusal.operationId === id
            ? { kind: "owner-live" }
            : acquired.refusal,
      };
    const scanned = await scanClosureStore(targetKeys, id);
    if (!scanned.ok) return scanned;
    const read = await leaseClosureTarget(owner, request, scanned.operations);
    if (!read.ok) return read;
    return {
      ok: true,
      order: acquired.order,
      operations: scanned.operations,
      target: read.target,
    };
  }

  function closureIntentOf(
    request: CloseRequest<string>,
    effect: string,
    target: Operation,
    targetKeys: readonly string[] | undefined,
    order: readonly string[],
  ): Omit<Intent, "operationId" | "runId" | "owner"> {
    const caseKey = `case:${request.operationId}`;
    return {
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
      revisions: { [caseKey]: target.revision },
      facts: { closes: request.operationId, closureId: request.closureId },
      approval: null,
      closes: request.operationId,
      coordination: order,
    };
  }

  async function runClosingRecord<Effect extends string>(
    owner: LockOwner,
    issuer: StateIssuer,
    runId: string,
    declared: readonly Effect[],
    effect: Effect,
    decision: Closure,
    opened: NonNullable<Awaited<ReturnType<typeof open>>>,
    slot: Extract<Slot, { kind: "close" }>,
  ): Promise<TransactionProof<Effect>> {
    owner.holdRunLease(opened.releaseLease);
    const { observation } = await runRecorded(
      issuer,
      runId,
      declared,
      { events: opened.events, ...owner.transferToRun() },
      (transaction) =>
        transaction
          .record(
            effect,
            async () => {
              const published = await publishClosure(paths, decision, () =>
                phase("closure-staged"),
              );
              await phase("closure-published");
              return published;
            },
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
    const owner = createLockOwner();
    try {
      const admitted = await admitClosure(owner, request, targetKeys);
      if (!admitted.ok) return stop(admitted.stop);
      const decision = await closureDecision(admitted.target, request, runId);
      if (!("closureId" in decision)) return stop(decision);
      const intent = closureIntentOf(
        request,
        effect,
        admitted.target,
        targetKeys,
        admitted.order,
      );
      const opened = await open(runId, intent, {
        releaseAdmission: owner.releaseAdmission,
        operations: admitted.operations,
      });
      if (!opened)
        return stop({ kind: "unavailable", reason: "store-publication" });
      return await runClosingRecord(
        owner,
        issuer,
        runId,
        declared,
        effect,
        decision,
        opened,
        slot,
      );
    } finally {
      owner.releaseAll();
    }
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
        : work(
            inner,
            Object.freeze({
              operationId: slot.operationId,
              ...(slot.superseded === undefined
                ? {}
                : { superseded: slot.superseded }),
            }),
          );
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
