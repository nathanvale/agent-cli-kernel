import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import type { StateIssuer } from "../../kernel/index.ts";
import { errorCode } from "../../shared/error-code.ts";
import {
  encodeRecord,
  parseRecords,
  plainObject,
  recordStartsMidLine,
} from "./framing.ts";
import type { ParsedRecord } from "./framing.ts";
import type { CanonicalScope } from "./scope.ts";

export {
  lstatSync as readLinkStats,
  readFileSync as readStoreFile,
  readlinkSync as readLinkTarget,
  realpathSync as resolveRealPath,
  statSync as readPathStats,
  statfsSync as readFilesystemStats,
};

export const operationPattern = /^op-[0-9a-f]{32}$/;

export function layout(root: string) {
  return {
    root,
    format: join(root, "format"),
    coordination: join(root, "coordination"),
    admission: join(root, "coordination", "admission.lock"),
    operations: join(root, "operations"),
    settled: join(root, "settled"),
    staging: join(root, "staging"),
    operation: (id: string) => join(root, "operations", id),
    settledCase: (id: string) => join(root, "settled", id),
    keyLock: (key: string) =>
      join(
        root,
        "coordination",
        `k-${createHash("sha256").update(key).digest("hex").slice(0, 32)}.lock`,
      ),
  };
}
export type Layout = ReturnType<typeof layout>;

function flushDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readJournalFile(path: string): Uint8Array {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("The journal file is not a regular file.");
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurable(path: string, bytes: Uint8Array, exclusive = true): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : constants.O_TRUNC),
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function lstatOptional(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function privateDirectory(path: string): boolean {
  const stats = lstatSync(path);
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.uid === process.getuid?.() &&
    (stats.mode & 0o022) === 0
  );
}

export function ensureStore(paths: Layout): boolean {
  if (!isAbsolute(paths.root)) return false;
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    if (!privateDirectory(paths.root)) return false;
    for (const directory of [
      paths.coordination,
      paths.operations,
      paths.staging,
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!privateDirectory(directory)) return false;
    }
    try {
      lstatSync(paths.format);
    } catch {
      const staged = join(paths.staging, `format-${crypto.randomUUID()}`);
      writeDurable(staged, encodeRecord("format", { journal: journals.one }));
      try {
        linkSync(staged, paths.format);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      rmSync(staged, { force: true });
      flushDirectory(paths.root);
    }
    return storeProblem(paths) === undefined;
  } catch {
    return false;
  }
}

const journals = { one: "contract3.state", two: "contract3.state.2" } as const;
type Journal = (typeof journals)[keyof typeof journals];

function journalOf(paths: Layout): Journal | undefined {
  const parsed = parseRecords(readJournalFile(paths.format));
  const record = parsed.ok && !parsed.tornTail ? parsed.records : [];
  const journal = record[0]?.payload.journal;
  return record.length === 1 && record[0]?.kind === "format"
    ? Object.values(journals).find((known) => known === journal)
    : undefined;
}

export type UpgradePhase = "upgrade-staged" | "upgraded";

export type UpgradeProblem = "store-upgrade" | "store-upgrade-unconfirmed";

const writeReceipt = Symbol("state.writeReceipt");
const writeReceipts = new WeakSet<object>();
export type WriteReceipt<T> = {
  readonly [writeReceipt]: true;
  readonly value: T;
};
function finishWrite<V>(value: V): WriteReceipt<V> {
  const receipt = Object.freeze({ [writeReceipt]: true as const, value });
  writeReceipts.add(receipt);
  return receipt;
}
function unwrapWrite<T>(receipt: WriteReceipt<T>): T {
  if (!writeReceipts.has(receipt))
    throw new Error("A store write must return a synchronous write receipt.");
  writeReceipts.delete(receipt);
  return receipt.value;
}
export type WriteGate = <T>(
  write: (done: <V>(value: V) => WriteReceipt<V>) => WriteReceipt<T>,
) => T;

export function openRunWriteGate(
  ifOpen: StateIssuer["ifOpen"],
  runId: string,
): WriteGate {
  return (write) =>
    ifOpen(runId, (done) => done(unwrapWrite(write(finishWrite))));
}

export function unflaggedWriteGate(): WriteGate {
  return (write) => unwrapWrite(write(finishWrite));
}

export type StagedUpgrade =
  | { readonly kind: "current" }
  | { readonly kind: "failed" }
  | { readonly kind: "staged"; readonly staged: string };

export function stageStoreUpgrade(
  gate: WriteGate,
  paths: Layout,
): StagedUpgrade {
  const staged = join(paths.staging, `format-${crypto.randomUUID()}`);
  try {
    const journal = journalOf(paths);
    if (journal === journals.two) return { kind: "current" };
    if (journal !== journals.one) return { kind: "failed" };
    const prepared = gate((done) => {
      mkdirSync(paths.settled, { recursive: true, mode: 0o700 });
      if (!privateDirectory(paths.settled)) return done(false);
      flushDirectory(paths.root);
      writeDurable(staged, encodeRecord("format", { journal: journals.two }));
      return done(true);
    });
    return prepared ? { kind: "staged", staged } : { kind: "failed" };
  } catch {
    discardStagedFile(staged);
    return { kind: "failed" };
  }
}

export function publishStoreUpgrade(
  gate: WriteGate,
  paths: Layout,
  staged: string,
): UpgradeProblem | undefined {
  let replaced = false;
  try {
    gate((done) => {
      renameSync(staged, paths.format);
      replaced = true;
      flushDirectory(paths.root);
      return done(undefined);
    });
    return undefined;
  } catch {
    if (replaced) return "store-upgrade-unconfirmed";
    discardStagedFile(staged);
    return "store-upgrade";
  }
}

export function discardStagedFile(staged: string): void {
  try {
    rmSync(staged, { force: true });
  } catch {
    return;
  }
}

export function discardStagedOperation(staged: string): void {
  try {
    rmSync(staged, { recursive: true, force: true });
  } catch {
    return;
  }
}

export function settledIsPrivate(paths: Layout): boolean {
  try {
    return privateDirectory(paths.settled);
  } catch {
    return false;
  }
}

export type Intent = {
  readonly operationId: string;
  readonly commandIdentity: string;
  readonly runId: string;
  readonly effects: readonly string[];
  readonly scope: CanonicalScope;
  readonly revisions: Readonly<Record<string, string>>;
  readonly facts: unknown;
  readonly approval: {
    readonly kind: "preview";
    readonly reference: string;
  } | null;
  readonly closes: string | null;
  readonly owner: {
    readonly lease: "owner.lease";
    readonly pid: number;
    readonly startedAt: number;
  };
  readonly coordination: readonly string[];
};

export const recordKinds = { intent: "intent", closure: "closure" } as const;
const startingEventKinds = ["effect-started", "delegate-admitted"] as const;
const settlingEventKinds = [
  "effect-confirmed",
  "effect-unconfirmed",
  "completion",
  "not-applied",
  "outcome",
  "emergency",
] as const;
const eventKinds = [...startingEventKinds, ...settlingEventKinds] as const;
export type StartingEventKind = (typeof startingEventKinds)[number];
export type SettlingEventKind = (typeof settlingEventKinds)[number];
export type EventKind = (typeof eventKinds)[number];
const effectEvents: readonly EventKind[] = [
  "effect-started",
  "delegate-admitted",
  "effect-confirmed",
  "effect-unconfirmed",
];
export type JournalEvent = {
  readonly kind: EventKind;
  readonly effect?: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export function appendDelegateStart(
  gate: WriteGate,
  eventsPath: string,
  effect: string,
  boot: string | undefined,
): void {
  appendStartedEvent(
    gate,
    eventsPath,
    "delegate-admitted",
    boot === undefined ? { effect } : { effect, boot },
  );
}

export function delegateBoot(event: JournalEvent): string | undefined {
  const boot = event.payload.boot;
  return event.kind === "delegate-admitted" &&
    typeof boot === "string" &&
    boot !== ""
    ? boot
    : undefined;
}

export const dispositions = [
  "completed",
  "not-applied",
  "outcome-unknown",
] as const;
export type Disposition = (typeof dispositions)[number];
export type Closure = {
  readonly operationId: string;
  readonly closureId: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly evidence: readonly {
    readonly effect: string;
    readonly observation: string;
  }[];
  readonly authority: unknown;
  readonly journalRevision: string;
  readonly qualification: string;
  readonly recoveryRunId: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function texts(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const item = text(entry);
    if (item === undefined) return undefined;
    out.push(item);
  }
  return out;
}
function sortedUnique(value: readonly string[]): boolean {
  return value.every(
    (entry, index) => index === 0 || (value[index - 1] ?? "") < entry,
  );
}

function parseScope(value: unknown): CanonicalScope | undefined {
  const scope = plainObject(value);
  if (!scope || typeof scope.unknown !== "boolean") return undefined;
  const keys = texts(scope.keys);
  const invariants = texts(scope.invariants);
  if (!keys || !invariants || !Array.isArray(scope.resources)) return undefined;
  const resources: CanonicalScope["resources"][number][] = [];
  for (const entry of scope.resources) {
    const item = plainObject(entry);
    const resource = text(item?.resource);
    const itemKeys = texts(item?.keys);
    if (!item || !resource || !itemKeys) return undefined;
    const path = text(item.path);
    const key = text(item.key);
    if (path !== undefined && key === undefined)
      resources.push({ resource, path, keys: itemKeys });
    else if (key !== undefined && path === undefined)
      resources.push({ resource, key, keys: itemKeys });
    else return undefined;
  }
  return { resources, invariants, unknown: scope.unknown, keys };
}

export function parseRevisions(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const revision = text(entry);
    if (revision === undefined) return undefined;
    Object.defineProperty(out, key, {
      value: revision,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

export function parseApproval(value: unknown): Intent["approval"] | undefined {
  if (value === null) return null;
  const approval = plainObject(value);
  const reference = text(approval?.reference);
  return approval?.kind === "preview" && reference !== undefined
    ? { kind: "preview", reference }
    : undefined;
}

function parseOwner(value: unknown): Intent["owner"] | undefined {
  const owner = plainObject(value);
  return owner?.lease === "owner.lease" &&
    typeof owner.pid === "number" &&
    typeof owner.startedAt === "number"
    ? { lease: "owner.lease", pid: owner.pid, startedAt: owner.startedAt }
    : undefined;
}

function parseEffects(value: unknown): readonly string[] | undefined {
  const effects = texts(value);
  return effects && effects.length > 0 && sortedUnique(effects)
    ? effects
    : undefined;
}

function parseIntent(record: ParsedRecord, id: string): Intent | undefined {
  const value = record.payload;
  const commandIdentity = text(value.commandIdentity);
  const runId = text(value.runId);
  const effects = parseEffects(value.effects);
  const scope = parseScope(value.scope);
  const revisions = parseRevisions(value.revisions);
  const owner = parseOwner(value.owner);
  const coordination = texts(value.coordination);
  const approval = parseApproval(value.approval);
  const closes = value.closes === null ? null : text(value.closes);
  if (record.kind !== recordKinds.intent || value.operationId !== id)
    return undefined;
  if (!commandIdentity || !runId || !effects || !scope || !revisions)
    return undefined;
  if (!owner || !coordination || approval === undefined || closes === undefined)
    return undefined;
  return {
    operationId: id,
    commandIdentity,
    runId,
    effects,
    scope,
    revisions,
    facts: value.facts ?? null,
    approval,
    closes,
    owner,
    coordination,
  };
}

function parseEvent(
  record: ParsedRecord,
  effects: readonly string[],
): JournalEvent | undefined {
  const kind = eventKinds.find((entry) => entry === record.kind);
  if (!kind) return undefined;
  const effect = text(record.payload.effect);
  if (
    effectEvents.includes(kind) &&
    (effect === undefined || !effects.includes(effect))
  )
    return undefined;
  return effect === undefined
    ? { kind, payload: record.payload }
    : { kind, effect, payload: record.payload };
}

function parseClosure(record: ParsedRecord, id: string): Closure | undefined {
  const value = record.payload;
  const disposition = dispositions.find((entry) => entry === value.disposition);
  const closureId = text(value.closureId);
  const reason = text(value.reason);
  const journalRevision = text(value.journalRevision);
  const qualification = text(value.qualification);
  const recoveryRunId = text(value.recoveryRunId);
  if (
    record.kind !== recordKinds.closure ||
    value.operationId !== id ||
    !disposition ||
    !closureId ||
    !reason ||
    !journalRevision ||
    !qualification ||
    !recoveryRunId ||
    !Array.isArray(value.evidence)
  )
    return undefined;
  const evidence: { effect: string; observation: string }[] = [];
  for (const entry of value.evidence) {
    const item = plainObject(entry);
    const effect = text(item?.effect);
    const observation = text(item?.observation);
    if (!effect || !observation) return undefined;
    evidence.push({ effect, observation });
  }
  return {
    operationId: id,
    closureId,
    disposition,
    reason,
    evidence,
    authority: value.authority ?? null,
    journalRevision,
    qualification,
    recoveryRunId,
  };
}

export type Operation = {
  readonly intent: Intent;
  readonly intentBytes: Uint8Array;
  readonly eventBytes: Uint8Array;
  readonly events: readonly JournalEvent[];
  readonly tornTail: boolean;
  readonly recordHiddenInTornTail: boolean;
  readonly closure: Closure | undefined;
  readonly closureDamaged: boolean;
  readonly status: "closed" | "completed" | "not-applied" | "unresolved";
  readonly revision: string;
};

export type ReadResult =
  | { readonly ok: true; readonly operations: readonly Operation[] }
  | {
      readonly ok: false;
      readonly reason: "missing" | "unreadable" | "corrupt";
      readonly detail?: string;
    };

function readOptional(path: string): Uint8Array | undefined {
  try {
    return readJournalFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export function revisionOf(
  intentBytes: Uint8Array,
  eventBytes: Uint8Array,
): string {
  return `r-${createHash("sha256").update(intentBytes).update("\n").update(eventBytes).digest("hex")}`;
}

function readIntent(directory: string, id: string) {
  const bytes = readOptional(join(directory, "intent"));
  if (!bytes) return undefined;
  const file = parseRecords(bytes);
  const record =
    file.ok && !file.tornTail && file.records.length === 1
      ? file.records[0]
      : undefined;
  const intent = record && parseIntent(record, id);
  return intent ? { intent, bytes } : undefined;
}

function readEvents(directory: string, effects: readonly string[]) {
  const bytes = readOptional(join(directory, "events"));
  if (!bytes) return undefined;
  const file = parseRecords(bytes);
  if (!file.ok) return undefined;
  const events = file.records.map((record) => parseEvent(record, effects));
  const valid = events.flatMap((event) => (event ? [event] : []));
  return valid.length === events.length
    ? { events: valid, bytes, tornTail: file.tornTail }
    : undefined;
}

function closureState(directory: string, id: string) {
  const bytes = readOptional(join(directory, "closure"));
  if (!bytes) return { closure: undefined, closureDamaged: false };
  const parsed = parseRecords(bytes);
  const record =
    parsed.ok && !parsed.tornTail && parsed.records.length === 1
      ? parsed.records[0]
      : undefined;
  const closure = record ? parseClosure(record, id) : undefined;
  return { closure, closureDamaged: closure === undefined };
}

function statusOf(
  closure: Closure | undefined,
  events: readonly JournalEvent[],
): Operation["status"] {
  if (closure) return "closed";
  const own = events.find(
    (event) => event.kind === "completion" || event.kind === "not-applied",
  );
  return own?.kind === "completion"
    ? "completed"
    : own?.kind === "not-applied"
      ? "not-applied"
      : "unresolved";
}

function readOperationIn(directory: string, id: string): Operation | "corrupt" {
  if (!privateDirectory(directory)) return "corrupt";
  const intent = readIntent(directory, id);
  const events = intent && readEvents(directory, intent.intent.effects);
  if (!intent || !events) return "corrupt";
  const { closure, closureDamaged } = closureState(directory, id);
  return {
    intent: intent.intent,
    intentBytes: intent.bytes,
    eventBytes: events.bytes,
    events: events.events,
    tornTail: events.tornTail,
    recordHiddenInTornTail:
      events.tornTail && recordStartsMidLine(events.bytes),
    closure,
    closureDamaged,
    status: statusOf(closure, events.events),
    revision: revisionOf(intent.bytes, events.bytes),
  };
}

function folderRemains(directory: string): boolean {
  try {
    lstatSync(directory);
    return true;
  } catch (error) {
    return errorCode(error) !== "ENOENT";
  }
}

function fromCaseFolders<T>(
  paths: Layout,
  id: string,
  read: (directory: string) => T,
): T | "not-found" {
  for (const directory of [paths.operation(id), paths.settledCase(id)]) {
    const value = read(directory);
    if (folderRemains(directory)) return value;
  }
  return "not-found";
}

function readCaseIn(
  directory: string,
  id: string,
): Operation | "corrupt" | "unreadable" {
  try {
    return readOperationIn(directory, id);
  } catch {
    return "unreadable";
  }
}

export type CaseRead = Operation | "not-found" | "corrupt" | "unreadable";

export function readCase(paths: Layout, id: string): CaseRead {
  return fromCaseFolders(paths, id, (directory) => readCaseIn(directory, id));
}

export function storeProblem(
  paths: Layout,
): "missing" | "unreadable" | "corrupt" | undefined {
  try {
    lstatSync(paths.root);
  } catch {
    return "missing";
  }
  try {
    const journal = journalOf(paths);
    return privateDirectory(paths.root) &&
      journal !== undefined &&
      (journal === journals.one || privateDirectory(paths.settled))
      ? undefined
      : "corrupt";
  } catch {
    return "unreadable";
  }
}

function strayEntryProblem(
  entryPath: string,
  name: string,
): ReadResult | undefined {
  const stats = lstatOptional(entryPath);
  if (stats?.isDirectory())
    return {
      ok: false,
      reason: "corrupt",
      detail: `unexpected folder in journal: ${name}`,
    };
  return undefined;
}

export function readStore(paths: Layout): ReadResult {
  const problem = storeProblem(paths);
  if (problem) return { ok: false, reason: problem };
  try {
    const operations: Operation[] = [];
    for (const name of readdirSync(paths.operations).sort()) {
      const entryPath = paths.operation(name);
      if (!operationPattern.test(name)) {
        const stray = strayEntryProblem(entryPath, name);
        if (stray) return stray;
        continue;
      }
      const read = readCaseIn(entryPath, name);
      if (!folderRemains(entryPath)) continue;
      if (read === "corrupt" || read === "unreadable")
        return { ok: false, reason: read };
      operations.push(read);
    }
    return { ok: true, operations };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export function moveSettledCase(
  gate: WriteGate,
  paths: Layout,
  id: string,
): "moved" | "occupied" {
  const source = paths.operation(id);
  if (!privateDirectory(source))
    throw new Error(`Case folder ${id} is not a private directory.`);
  if (!privateDirectory(paths.settled))
    throw new Error("The settled folder is not a private directory.");
  try {
    lstatSync(paths.settledCase(id));
    return "occupied";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return gate((done) => {
    renameSync(source, paths.settledCase(id));
    return done("moved");
  });
}

export function flushMoves(paths: Layout): void {
  flushDirectory(paths.operations);
  flushDirectory(paths.settled);
}

export type StagedOperation =
  | {
      readonly ok: true;
      readonly staged: string;
      readonly releaseLease: () => void;
    }
  | { readonly ok: false };

export function stageOperation(
  gate: WriteGate,
  paths: Layout,
  intent: Intent,
  lockLease: (path: string) => (() => void) | undefined,
  removeOnFailure: boolean,
): StagedOperation {
  const staged = join(paths.staging, intent.operationId);
  return gate<StagedOperation>((done) => {
    mkdirSync(staged, { mode: 0o700 });
    const releaseLease = lockLease(join(staged, "owner.lease"));
    if (!releaseLease) return done<StagedOperation>({ ok: false });
    try {
      writeDurable(
        join(staged, "intent"),
        encodeRecord(recordKinds.intent, intent),
      );
      writeDurable(join(staged, "events"), new Uint8Array(0));
      flushDirectory(staged);
    } catch (error) {
      releaseLease();
      if (removeOnFailure) discardStagedOperation(staged);
      throw error;
    }
    return done<StagedOperation>({ ok: true, staged, releaseLease });
  });
}

export function commitOperation(
  gate: WriteGate,
  paths: Layout,
  operationId: string,
  staged: string,
): string {
  gate((done) => {
    renameSync(staged, paths.operation(operationId));
    flushDirectory(paths.operations);
    return done(undefined);
  });
  return join(paths.operation(operationId), "events");
}

const settlingEvents: readonly EventKind[] = ["completion", "not-applied"];

function endsOnWholeRecord(descriptor: number): boolean {
  const size = fstatSync(descriptor).size;
  const bytes = new Uint8Array(size);
  let read = 0;
  while (read < size) {
    const count = readSync(descriptor, bytes, read, size - read, read);
    if (count === 0) break;
    read += count;
  }
  const parsed = parseRecords(bytes.subarray(0, read));
  return parsed.ok && !parsed.tornTail;
}

// Accepted decision (Nathan, 19 November 2026, 16:29 AEDT): nothing is
// appended after torn bytes, so a failed partial write ends the case's
// journal and a later delegate start refuses before its program starts.
// Interface: each append reads the whole events file once, so one append
// costs time linear in the records already written and a case's appends
// cost time quadratic in its records: three per declared effect, one per
// delegate start, and the final and emergency events.
function writeEventRecord(
  eventsPath: string,
  kind: EventKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  if (!privateDirectory(dirname(eventsPath)))
    throw new Error("Case folder is not a private directory.");
  const descriptor = openSync(
    eventsPath,
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("The journal events file is not a regular file.");
    if (!endsOnWholeRecord(descriptor))
      throw new Error(
        "The events file does not end on a whole record, so nothing more is appended to this case.",
      );
    const bytes = encodeRecord(
      kind,
      settlingEvents.includes(kind)
        ? { ...payload, settledAt: Date.now() }
        : payload,
    );
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function appendStartedEvent(
  gate: WriteGate,
  eventsPath: string,
  kind: StartingEventKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  gate((done) => {
    writeEventRecord(eventsPath, kind, payload);
    return done(undefined);
  });
}

export function appendSettlingEvent(
  eventsPath: string,
  kind: SettlingEventKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  writeEventRecord(eventsPath, kind, payload);
}

function linkStagedClosure(staged: string, target: string): boolean {
  try {
    linkSync(staged, target);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

export function stageClosure(
  gate: WriteGate,
  paths: Layout,
  closure: Closure,
): string {
  const staged = join(paths.staging, `closure-${crypto.randomUUID()}`);
  return gate((done) => {
    writeDurable(
      staged,
      encodeRecord(recordKinds.closure, { ...closure, settledAt: Date.now() }),
    );
    return done(staged);
  });
}

export function commitClosure(
  gate: WriteGate,
  paths: Layout,
  operationId: string,
  staged: string,
  commitLink?: (link: () => boolean) => void,
): "published" | "exists" {
  const state: { outcome: "published" | "exists" } = { outcome: "exists" };
  const directory = paths.operation(operationId);
  const target = join(directory, "closure");
  const link = () => {
    if (!privateDirectory(directory))
      throw new Error(`Case folder ${operationId} is not a private directory.`);
    const linked = linkStagedClosure(staged, target);
    if (linked) state.outcome = "published";
    return linked;
  };
  try {
    gate((done) => {
      if (commitLink) commitLink(link);
      else link();
      return done(undefined);
    });
  } finally {
    rmSync(staged, { force: true });
  }
  if (state.outcome === "published") flushDirectory(directory);
  return state.outcome;
}

export type ClosureRead = Closure | "damaged" | "unreadable" | undefined;

export function readClosure(paths: Layout, id: string): ClosureRead {
  const found = fromCaseFolders(paths, id, (directory) =>
    closureIn(directory, id),
  );
  return found === "not-found" ? undefined : found;
}

function closureIn(directory: string, id: string): ClosureRead {
  let bytes: Uint8Array | undefined;
  try {
    if (!privateDirectory(directory)) return "unreadable";
    bytes = readOptional(join(directory, "closure"));
  } catch {
    return "unreadable";
  }
  if (!bytes) return undefined;
  const parsed = parseRecords(bytes);
  const record =
    parsed.ok && !parsed.tornTail && parsed.records.length === 1
      ? parsed.records[0]
      : undefined;
  return (record && parseClosure(record, id)) ?? "damaged";
}
