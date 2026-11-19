import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { errorCode } from "./coordination.ts";
import { encodeRecord, parseRecords, plainObject } from "./framing.ts";
import type { ParsedRecord } from "./framing.ts";
import type { CanonicalScope } from "./scope.ts";

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
        if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
      }
      rmSync(staged, { force: true });
      flushDirectory(paths.root);
    }
    return journalOf(paths) !== undefined;
  } catch {
    return false;
  }
}

const journals = { one: "contract3.state", two: "contract3.state.2" } as const;
type Journal = (typeof journals)[keyof typeof journals];

function journalOf(paths: Layout): Journal | undefined {
  const parsed = parseRecords(readFileSync(paths.format));
  const record = parsed.ok && !parsed.tornTail ? parsed.records : [];
  const journal = record[0]?.payload.journal;
  return record.length === 1 && record[0]?.kind === "format"
    ? Object.values(journals).find((known) => known === journal)
    : undefined;
}

export type UpgradePhase = "upgrade-staged" | "upgraded";

export async function upgradeStore(
  paths: Layout,
  phase: (name: UpgradePhase) => Promise<void>,
): Promise<void> {
  const journal = journalOf(paths);
  if (journal === journals.two) return;
  if (journal !== journals.one)
    throw new Error("The format record names no known journal.");
  mkdirSync(paths.settled, { recursive: true, mode: 0o700 });
  if (!privateDirectory(paths.settled))
    throw new Error("settled/ is not a private directory.");
  flushDirectory(paths.root);
  const staged = join(paths.staging, `format-${crypto.randomUUID()}`);
  writeDurable(staged, encodeRecord("format", { journal: journals.two }));
  await phase("upgrade-staged");
  renameSync(staged, paths.format);
  flushDirectory(paths.root);
  await phase("upgraded");
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
const eventKinds = [
  "effect-started",
  "delegate-admitted",
  "effect-confirmed",
  "effect-unconfirmed",
  "completion",
  "not-applied",
  "outcome",
  "emergency",
] as const;
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

function parseRevisions(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const revisions = plainObject(value);
  if (!revisions) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(revisions)) {
    const revision = text(entry);
    if (revision === undefined) return undefined;
    out[key] = revision;
  }
  return out;
}

function parseApproval(value: unknown): Intent["approval"] | undefined {
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
    };

function readOptional(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") return undefined;
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
    return privateDirectory(paths.root) && journalOf(paths) !== undefined
      ? undefined
      : "corrupt";
  } catch {
    return "unreadable";
  }
}

export function readStore(paths: Layout): ReadResult {
  const problem = storeProblem(paths);
  if (problem) return { ok: false, reason: problem };
  try {
    const operations: Operation[] = [];
    for (const name of readdirSync(paths.operations).sort()) {
      if (!operationPattern.test(name)) return { ok: false, reason: "corrupt" };
      const read = readCaseIn(paths.operation(name), name);
      if (!folderRemains(paths.operation(name))) continue;
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
  paths: Layout,
  id: string,
): "moved" | "occupied" {
  try {
    lstatSync(paths.settledCase(id));
    return "occupied";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  renameSync(paths.operation(id), paths.settledCase(id));
  return "moved";
}

export function flushMoves(paths: Layout): void {
  flushDirectory(paths.operations);
  flushDirectory(paths.settled);
}

export async function publishOperation(
  paths: Layout,
  intent: Intent,
  lockLease: (path: string) => (() => void) | undefined,
  beforePublish: () => Promise<void>,
): Promise<
  | {
      readonly ok: true;
      readonly releaseLease: () => void;
      readonly events: string;
    }
  | { readonly ok: false }
> {
  const staged = join(paths.staging, intent.operationId);
  mkdirSync(staged, { mode: 0o700 });
  const releaseLease = lockLease(join(staged, "owner.lease"));
  if (!releaseLease) return { ok: false };
  try {
    writeDurable(
      join(staged, "intent"),
      encodeRecord(recordKinds.intent, intent),
    );
    writeDurable(join(staged, "events"), new Uint8Array(0));
    flushDirectory(staged);
    await beforePublish();
    renameSync(staged, paths.operation(intent.operationId));
    flushDirectory(paths.operations);
  } catch (error) {
    releaseLease();
    throw error;
  }
  return {
    ok: true,
    releaseLease,
    events: join(paths.operation(intent.operationId), "events"),
  };
}

const settlingEvents: readonly EventKind[] = ["completion", "not-applied"];

export function appendEvent(
  eventsPath: string,
  kind: EventKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  const descriptor = openSync(
    eventsPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
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

export function publishClosure(
  paths: Layout,
  closure: Closure,
  beforeLink: () => Promise<void>,
): Promise<"published" | "exists"> {
  const staged = join(paths.staging, `closure-${crypto.randomUUID()}`);
  writeDurable(
    staged,
    encodeRecord(recordKinds.closure, { ...closure, settledAt: Date.now() }),
  );
  return beforeLink().then(() => {
    try {
      linkSync(staged, join(paths.operation(closure.operationId), "closure"));
    } catch (error) {
      if (Reflect.get(Object(error), "code") === "EEXIST") return "exists";
      throw error;
    } finally {
      rmSync(staged, { force: true });
    }
    flushDirectory(paths.operation(closure.operationId));
    return "published";
  });
}

export function readClosure(
  paths: Layout,
  id: string,
): Closure | "damaged" | undefined {
  const found = fromCaseFolders(paths, id, (directory) =>
    closureIn(directory, id),
  );
  return found === "not-found" ? undefined : found;
}

function closureIn(
  directory: string,
  id: string,
): Closure | "damaged" | undefined {
  const bytes = readOptional(join(directory, "closure"));
  if (!bytes) return undefined;
  const parsed = parseRecords(bytes);
  const record =
    parsed.ok && !parsed.tornTail && parsed.records.length === 1
      ? parsed.records[0]
      : undefined;
  return (record && parseClosure(record, id)) ?? "damaged";
}
