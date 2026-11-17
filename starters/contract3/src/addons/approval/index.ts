import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { issuedScope } from "../../kernel/index.ts";
import type {
  ApprovalCapability,
  ApprovalRequest,
  ApprovalRuntime,
  ExclusiveScope,
  Handoff,
  StateAddonDescriptor,
} from "../../kernel/index.ts";
import { consumeOnce, isConsumed, itemKey, markerPath } from "./store.ts";
import { readUntrusted } from "./read.ts";
import type { RecordFacts } from "./read.ts";
import { parseClosure, parseGrant, parseStop, sameSet } from "./records.ts";
import type { ClosureItem, Grant, StopItem } from "./records.ts";
import { ApprovalRejection } from "./rejection.ts";

export type { ClosureItem, StopItem } from "./records.ts";
export type { RecordFacts } from "./read.ts";
export { ApprovalRejection } from "./rejection.ts";
export type { RejectionReason } from "./rejection.ts";

export type ApprovalStore = {
  readonly grants: string;
  readonly consumed: string;
};

function absolute(directory: string): string {
  if (!isAbsolute(directory))
    throw new Error("Approval directories must be absolute paths.");
  return directory;
}

export function grantLocation(store: ApprovalStore, preview: string): string {
  return join(absolute(store.grants), `${itemKey(["approval", preview])}.json`);
}

function held(
  coordination: ExclusiveScope,
  runId: string,
  scope: string,
  state: StateAddonDescriptor,
): boolean {
  return (
    issuedScope(coordination, runId, state) &&
    coordination.isActive() === true &&
    coordination.runId === runId &&
    coordination.scope === scope
  );
}

async function consumeHeld(
  stillHeld: () => boolean,
  current: () => Promise<string | undefined>,
  record: () => string,
): Promise<boolean> {
  if (!stillHeld()) throw new ApprovalRejection("coordination-not-held");
  const marker = await current();
  if (marker === undefined) return false;
  if (!stillHeld()) throw new ApprovalRejection("coordination-not-held");
  const consumed = await consumeOnce(marker, record());
  if (consumed && !stillHeld())
    throw new ApprovalRejection("coordination-lost");
  return consumed;
}

function grantMatches(
  grant: Grant,
  request: ApprovalRequest,
  operation: string,
  now: number,
): boolean {
  return (
    grant.operation === operation &&
    grant.preview === request.preview &&
    grant.authority === request.authority &&
    grant.resource === request.resource &&
    grant.resourceRevision === request.resourceRevision &&
    sameSet(grant.effects, request.effects) &&
    now < grant.expiresAt
  );
}

// Interface:
// - capability.check(request): non-consuming preflight. true only for a
//   valid, unconsumed grant that matches every binding. Never writes.
// - runtime(state): the consuming runtime, bound to the state add-on instance
//   whose descriptor the host gave contractFor. Its check is the same
//   preflight.
// - runtime(state).revalidateAndConsume(request, coordination): under a
//   held ExclusiveScope that `state`'s add-on instance issued for this run's
//   current attachment (same runId, scope equal to request.resource),
//   rereads, revalidates and consumes durably. consumed means the approved
//   effect may start.
// - Every denial is the same false / not-consumed result; no reason leaks.
// - Rejections are ApprovalRejection, never a denial:
//   coordination-not-held and store-unavailable leave the grant unconsumed;
//   coordination-lost and durability-unconfirmed mean consumed: the effect
//   must not start, the grant is never refunded, and the caller reports the
//   observed state under REC-1 to REC-10. Read `error.consumed`.
export function approval(options: {
  readonly operation: string;
  readonly runId: string;
  readonly store: ApprovalStore;
  readonly now?: () => number;
}): {
  readonly runtime: (state: StateAddonDescriptor) => ApprovalRuntime;
  readonly capability: ApprovalCapability;
} {
  const consumedDirectory = absolute(options.store.consumed);
  const now = options.now ?? Date.now;
  async function currentGrant(request: ApprovalRequest) {
    if (typeof request.preview !== "string") return undefined;
    const opened = await readUntrusted(
      grantLocation(options.store, request.preview),
    );
    const grant = opened && parseGrant(opened.value);
    return grant && grantMatches(grant, request, options.operation, now())
      ? markerPath(consumedDirectory, itemKey(["approval", request.preview]))
      : undefined;
  }
  async function check(request: ApprovalRequest) {
    const marker = await currentGrant(request);
    return marker !== undefined && !(await isConsumed(marker));
  }
  const runtime = (state: StateAddonDescriptor): ApprovalRuntime =>
    Object.freeze({
      check,
      async revalidateAndConsume(
        request: ApprovalRequest,
        coordination: ExclusiveScope,
      ) {
        const consumed = await consumeHeld(
          () => held(coordination, options.runId, request.resource, state),
          () => currentGrant(request),
          () => consumption("approval", options.runId, now()),
        );
        return { consumed };
      },
    });
  return Object.freeze({ runtime, capability: Object.freeze({ check }) });
}

function consumption(kind: string, runId: string, at: number): string {
  return `${JSON.stringify({ kind, runId, consumedAt: at })}\n`;
}

export type AuthoritySource = {
  readonly directory: string;
  // Interface: Host-owned qualification (V-42). Called first without a record (could
  // the caller create one here?), then with the opened record's descriptor
  // facts (could the caller have created or altered this one?). True only
  // when the calling process cannot, with its own credentials.
  // fileSeparation is the add-on's own probe.
  readonly separated: (record?: RecordFacts) => Promise<boolean>;
};

export type AuthorityVerdict =
  | { readonly status: "verified" }
  | { readonly status: "refused" }
  | { readonly status: "unavailable"; readonly handoff: Handoff };

const handoff: Handoff = {
  owner: "human",
  reason:
    "No qualified authority integration can verify this decision, so the case stays unresolved.",
  inspect: [
    {
      kind: "instruction",
      text: "Inspect the case's retained evidence read-only, then ask its authority owner to decide through a qualified authority integration.",
    },
  ],
};
function unavailable(): AuthorityVerdict {
  return { status: "unavailable", handoff: structuredClone(handoff) };
}
const refused: AuthorityVerdict = Object.freeze({ status: "refused" });
const verified: AuthorityVerdict = Object.freeze({ status: "verified" });

export function fileSeparation(
  directory: string,
): (record?: RecordFacts) => Promise<boolean> {
  const root = absolute(directory);
  return async (record) => {
    const caller = process.getuid?.();
    if (caller === undefined || caller === 0 || normalize(root) !== root)
      return false;
    const groups = process.getgroups?.() ?? [];
    if (!(await foreignPath(root, caller, groups))) return false;
    return (
      record === undefined ||
      (await foreignRecord(root, record, caller, groups))
    );
  };
}

function foreignOwner(
  facts: { readonly uid: number; readonly gid: number; readonly mode: number },
  caller: number,
  groups: readonly number[],
): boolean {
  const groupWritable =
    (facts.mode & 0o020) !== 0 && groups.includes(facts.gid);
  return facts.uid !== caller && (facts.mode & 0o002) === 0 && !groupWritable;
}

async function callerWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function foreignPath(
  root: string,
  caller: number,
  groups: readonly number[],
): Promise<boolean> {
  const parts = root.split(sep).filter((part) => part.length > 0);
  const paths = parts.map((_, index) =>
    join(sep, ...parts.slice(0, index + 1)),
  );
  for (const path of [sep, ...paths]) {
    let facts;
    try {
      facts = await lstat(path);
    } catch {
      return false;
    }
    if (
      facts.isSymbolicLink() ||
      !facts.isDirectory() ||
      !foreignOwner(facts, caller, groups) ||
      (await callerWritable(path))
    )
      return false;
  }
  return true;
}

async function foreignRecord(
  root: string,
  record: RecordFacts,
  caller: number,
  groups: readonly number[],
): Promise<boolean> {
  if (dirname(record.path) !== root || !foreignOwner(record, caller, groups))
    return false;
  try {
    const entry = await lstat(record.path);
    return (
      entry.dev === record.dev &&
      entry.ino === record.ino &&
      !(await callerWritable(record.path))
    );
  } catch {
    return false;
  }
}

export type AuthoritySlot<Item> = {
  readonly preflight: (item: Item) => Promise<AuthorityVerdict>;
  readonly consume: (
    item: Item,
    coordination: ExclusiveScope,
    state: StateAddonDescriptor,
  ) => Promise<AuthorityVerdict>;
};

type Kind = "closure" | "stop";
function closureKey(item: Pick<ClosureItem, "operation">): readonly string[] {
  return ["closure", item.operation];
}
function stopKey(
  item: Pick<StopItem, "operation" | "owner">,
): readonly string[] {
  return ["stop", item.operation, item.owner];
}
function recordPath(source: AuthoritySource, key: readonly string[]): string {
  return join(absolute(source.directory), `${itemKey(key)}.json`);
}

function slot<Item extends { readonly scope: string }>(
  options: {
    readonly runId: string;
    readonly consumed: string;
    readonly now: () => number;
    readonly source: AuthoritySource | undefined;
  },
  kind: Kind,
  key: (item: Item) => readonly string[],
  matches: (record: unknown, item: Item, now: number) => boolean,
): AuthoritySlot<Item> {
  async function current(item: Item): Promise<string | AuthorityVerdict> {
    const source = options.source;
    if (!source || !(await source.separated())) return unavailable();
    const opened = await readUntrusted(recordPath(source, key(item)));
    if (!opened) return refused;
    if (!(await source.separated(opened.facts))) return unavailable();
    return matches(opened.value, item, options.now())
      ? markerPath(options.consumed, itemKey(key(item)))
      : refused;
  }
  return Object.freeze({
    async preflight(item: Item) {
      const marker = await current(item);
      if (typeof marker !== "string") return marker;
      return (await isConsumed(marker)) ? refused : verified;
    },
    async consume(
      item: Item,
      coordination: ExclusiveScope,
      state: StateAddonDescriptor,
    ) {
      let verdict: AuthorityVerdict = refused;
      const consumed = await consumeHeld(
        () => held(coordination, options.runId, item.scope, state),
        async () => {
          const marker = await current(item);
          if (typeof marker === "string") return marker;
          verdict = marker;
          return undefined;
        },
        () => consumption(kind, options.runId, options.now()),
      );
      return consumed ? verified : verdict;
    },
  });
}

function closureMatches(
  record: unknown,
  item: ClosureItem,
  now: number,
): boolean {
  const parsed = parseClosure(record);
  return (
    parsed !== undefined &&
    parsed.operation === item.operation &&
    parsed.disposition === item.disposition &&
    parsed.evidence === item.evidence &&
    parsed.scope === item.scope &&
    now < parsed.expiresAt
  );
}

function stopMatches(record: unknown, item: StopItem, now: number): boolean {
  const parsed = parseStop(record);
  return (
    item.liveConflict === false &&
    parsed !== undefined &&
    parsed.operation === item.operation &&
    parsed.owner === item.owner &&
    sameSet(parsed.writers, item.writers) &&
    parsed.scope === item.scope &&
    now < parsed.expiresAt
  );
}

// Interface: consume() rejects with ApprovalRejection exactly as revalidateAndConsume.
export function authorityVerifier(options: {
  readonly runId: string;
  readonly consumed: string;
  readonly now?: () => number;
  readonly closure?: AuthoritySource;
  readonly stop?: AuthoritySource;
}): {
  readonly closure: AuthoritySlot<ClosureItem>;
  readonly stop: AuthoritySlot<StopItem>;
} {
  const shared = {
    runId: options.runId,
    consumed: absolute(options.consumed),
    now: options.now ?? Date.now,
  };
  return Object.freeze({
    closure: slot(
      { ...shared, source: options.closure },
      "closure",
      closureKey,
      closureMatches,
    ),
    stop: slot(
      { ...shared, source: options.stop },
      "stop",
      stopKey,
      stopMatches,
    ),
  });
}

export function authorityLocation(
  source: AuthoritySource,
  kind: "closure",
  item: ClosureItem,
): string;
export function authorityLocation(
  source: AuthoritySource,
  kind: "stop",
  item: StopItem,
): string;
export function authorityLocation(
  source: AuthoritySource,
  kind: "closure" | "stop",
  item: ClosureItem | StopItem,
): string {
  if (kind === "closure") return recordPath(source, closureKey(item));
  if ("owner" in item) return recordPath(source, stopKey(item));
  throw new Error("A stop record location needs a stop item.");
}
