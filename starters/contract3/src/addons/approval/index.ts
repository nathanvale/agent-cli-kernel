// Approval add-on (CMD-15, REC-5, REC-7a). Imports only the kernel public
// index (CMD-17). The host's wiring creates one approval add-on object per run
// and command; the handler receives only `capability`, while the state add-on's
// transaction receives `runtime(state)` to revalidate and consume under
// exclusive coordination before the approved effect (CMD-9 step 7).
//
// Consumption verifies at run time that the kernel issued the coordination
// (K2). That needs the state add-on instance's descriptor, which this
// add-on never imports from the state add-on: whoever holds it passes it in,
// the host composition (the descriptor it gives contractFor) or the state
// add-on (its own). Preflight needs no descriptor.
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
  // Directory of grant records, one per preview, named by grantLocation.
  readonly grants: string;
  // Directory of consumption markers. Shared by every authority kind.
  readonly ledger: string;
};

function absolute(directory: string): string {
  if (!isAbsolute(directory))
    throw new Error("Approval directories must be absolute paths.");
  return directory;
}

// Where an authority owner writes the grant for one preview.
export function grantLocation(store: ApprovalStore, preview: string): string {
  return join(absolute(store.grants), `${itemKey(["approval", preview])}.json`);
}

// The kernel brand stops only type-checked code from forging a scope, so the
// kernel's issuedScope is asked first: true only for the object the kernel
// issued, for this run, from `state`'s add-on instance, while that run's
// attachment is current and active. A look-alike or another add-on instance's
// scope never passes (reviewer probe P2).
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

// Consumes one marker under coordination. Coordination is checked before
// the fresh read, again before exclusive creation, and once more after the
// marker is durable, so a lost coordination is reported with whether the
// item was consumed.
async function consumeHeld(
  stillHeld: () => boolean,
  current: () => Promise<string | undefined>,
  record: () => string,
): Promise<boolean> {
  if (!stillHeld()) throw new ApprovalRejection("coordination-not-held");
  // Fresh under-lock read; the preflight result is never reused.
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
  const ledger = absolute(options.store.ledger);
  const now = options.now ?? Date.now;
  // Every denial reason collapses here into one indistinguishable value.
  async function currentGrant(request: ApprovalRequest) {
    if (typeof request.preview !== "string") return undefined;
    const opened = await readUntrusted(
      grantLocation(options.store, request.preview),
    );
    const grant = opened && parseGrant(opened.value);
    return grant && grantMatches(grant, request, options.operation, now())
      ? markerPath(ledger, itemKey(["approval", request.preview]))
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
        return { admitted: consumed };
      },
    });
  return Object.freeze({ runtime, capability: Object.freeze({ check }) });
}

function consumption(kind: string, runId: string, at: number): string {
  // Never a credential or approval secret (REC-1).
  return `${JSON.stringify({ kind, runId, consumedAt: at })}\n`;
}

// Human authority for outcome-unknown closure (REC-5) and stop
// confirmation (REC-7a). The two are separate sources, record formats and
// consumption namespaces; neither can stand in for the other or for a
// domain approval.
export type AuthoritySource = {
  readonly directory: string;
  // Host-owned qualification (V-42). Called first without a record (could
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
// A fresh copy per verdict, so no caller can alter another's handoff.
function unavailable(): AuthorityVerdict {
  return { status: "unavailable", handoff: structuredClone(handoff) };
}
const refused: AuthorityVerdict = Object.freeze({ status: "refused" });
const verified: AuthorityVerdict = Object.freeze({ status: "verified" });

// The add-on's own caller-credential probe for a file-backed source.
// Separation requires a normalized path whose every component from "/" to
// the source directory is a real directory (no symlink) that the caller
// neither owns nor can write, so the caller cannot swap any part of the
// path after the check. A record is judged on its opened descriptor and
// must still be the entry at its path. Root callers never qualify.
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

// consume takes the descriptor of the state add-on instance that issued the
// coordination (the state add-on's own), as revalidateAndConsume's runtime
// does; preflight needs none.
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
    readonly ledger: string;
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
      ? markerPath(options.ledger, itemKey(key(item)))
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

// consume() rejects with ApprovalRejection exactly as revalidateAndConsume.
export function authorityVerifier(options: {
  readonly runId: string;
  readonly ledger: string;
  readonly now?: () => number;
  readonly closure?: AuthoritySource;
  readonly stop?: AuthoritySource;
}): {
  readonly closure: AuthoritySlot<ClosureItem>;
  readonly stop: AuthoritySlot<StopItem>;
} {
  const shared = {
    runId: options.runId,
    ledger: absolute(options.ledger),
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

// Where a qualified authority integration writes the record for one item.
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
