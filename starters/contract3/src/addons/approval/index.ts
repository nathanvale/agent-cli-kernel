// Approval add-on (CMD-15, REC-5, REC-7a). Imports only the kernel public
// index (CMD-17). The host composition creates one instance per run and
// command; the handler receives only `capability`, while the state add-on's
// transaction receives `runtime` to revalidate and consume under exclusive
// coordination before the approved effect (CMD-9 step 7).
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  ApprovalCapability,
  ApprovalRequest,
  ApprovalRuntime,
  ExclusiveScope,
  Handoff,
} from "../../kernel/index.ts";
import { consumeOnce, isConsumed, itemKey, markerPath } from "./ledger.ts";
import { readUntrusted } from "./read.ts";
import { parseClosure, parseGrant, parseStop, sameSet } from "./records.ts";
import type { ClosureItem, Grant, StopItem } from "./records.ts";

export type { ClosureItem, StopItem } from "./records.ts";

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

function assertCoordination(
  coordination: ExclusiveScope,
  runId: string,
  scope: string,
): void {
  // A coordination fault is not an authority denial: the grant stays
  // unconsumed and the caller reports its own coordination outcome.
  if (
    coordination.isActive() !== true ||
    coordination.runId !== runId ||
    coordination.scope !== scope
  )
    throw new Error("Exclusive coordination for this item is not held.");
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

export function approval(options: {
  readonly operation: string;
  readonly runId: string;
  readonly store: ApprovalStore;
  readonly now?: () => number;
}): {
  readonly runtime: ApprovalRuntime;
  readonly capability: ApprovalCapability;
} {
  const ledger = absolute(options.store.ledger);
  const now = options.now ?? Date.now;
  // Every denial reason collapses here into one indistinguishable value.
  async function currentGrant(request: ApprovalRequest) {
    if (typeof request.preview !== "string") return undefined;
    const read = await readUntrusted(
      grantLocation(options.store, request.preview),
    );
    const grant = read.kind === "value" ? parseGrant(read.value) : undefined;
    return grant && grantMatches(grant, request, options.operation, now())
      ? markerPath(ledger, itemKey(["approval", request.preview]))
      : undefined;
  }
  const runtime: ApprovalRuntime = Object.freeze({
    async check(request: ApprovalRequest) {
      const marker = await currentGrant(request);
      return marker !== undefined && !(await isConsumed(marker));
    },
    async revalidateAndConsume(
      request: ApprovalRequest,
      coordination: ExclusiveScope,
    ) {
      assertCoordination(coordination, options.runId, request.resource);
      // Fresh under-lock read; the preflight result is never reused.
      const marker = await currentGrant(request);
      if (marker === undefined) return { admitted: false };
      assertCoordination(coordination, options.runId, request.resource);
      const admitted = await consumeOnce(
        marker,
        consumption("approval", options.runId, now()),
      );
      if (admitted)
        assertCoordination(coordination, options.runId, request.resource);
      return { admitted };
    },
  });
  return Object.freeze({
    runtime,
    capability: Object.freeze({ check: runtime.check }),
  });
}

function consumption(kind: string, runId: string, at: number): string {
  // Never a credential or approval secret (REC-1).
  return `${JSON.stringify({ kind, runId, consumedAt: at })}\n`;
}

// Human authority for unknown-outcome closure (REC-5) and stop
// confirmation (REC-7a). The two are separate sources, record formats and
// consumption namespaces; neither can stand in for the other or for a
// domain approval.
export type AuthoritySource = {
  readonly directory: string;
  // True only when the calling process cannot create or alter a valid
  // record at this path with its own credentials. Host-owned
  // qualification (V-42); fileSeparation is the add-on's own probe.
  readonly separated: (record: string) => Promise<boolean>;
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

// The add-on's own caller-credential probe for a file-backed source. A
// directory or record the caller owns or can write is self-issuable, so it
// never qualifies, whatever the record says about who granted it.
export function fileSeparation(
  directory: string,
): (record: string) => Promise<boolean> {
  const root = absolute(directory);
  return async (record) =>
    (await foreign(root, true)) && (await foreign(record, false));
}

async function foreign(path: string, required: boolean): Promise<boolean> {
  const caller = process.getuid?.();
  if (caller === undefined) return false;
  try {
    const info = await stat(path);
    if (info.uid === caller) return false;
  } catch {
    return !required;
  }
  try {
    await access(path, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

export type AuthoritySlot<Item> = {
  readonly preflight: (item: Item) => Promise<AuthorityVerdict>;
  readonly consume: (
    item: Item,
    coordination: ExclusiveScope,
  ) => Promise<AuthorityVerdict>;
};

function slot<Item extends { readonly scope: string }>(
  options: {
    readonly runId: string;
    readonly ledger: string;
    readonly now: () => number;
    readonly source: AuthoritySource | undefined;
  },
  kind: "closure" | "stop",
  key: (item: Item) => readonly string[],
  matches: (record: unknown, item: Item, now: number) => boolean,
): AuthoritySlot<Item> {
  async function current(item: Item) {
    const source = options.source;
    const name = itemKey([kind, ...key(item)]);
    const record = source && join(absolute(source.directory), `${name}.json`);
    if (!source || !record || !(await source.separated(record)))
      return unavailable();
    const read = await readUntrusted(record);
    return read.kind === "value" && matches(read.value, item, options.now())
      ? markerPath(options.ledger, name)
      : refused;
  }
  return Object.freeze({
    async preflight(item: Item) {
      const marker = await current(item);
      if (typeof marker !== "string") return marker;
      return (await isConsumed(marker)) ? refused : verified;
    },
    async consume(item: Item, coordination: ExclusiveScope) {
      assertCoordination(coordination, options.runId, item.scope);
      const marker = await current(item);
      if (typeof marker !== "string") return marker;
      assertCoordination(coordination, options.runId, item.scope);
      const done = await consumeOnce(
        marker,
        consumption(kind, options.runId, options.now()),
      );
      if (done) assertCoordination(coordination, options.runId, item.scope);
      return done ? verified : refused;
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
      (item: ClosureItem) => [item.operation],
      closureMatches,
    ),
    stop: slot(
      { ...shared, source: options.stop },
      "stop",
      (item: StopItem) => [item.operation, item.owner],
      stopMatches,
    ),
  });
}

// Where a qualified authority integration writes one record.
export function authorityLocation(
  source: AuthoritySource,
  kind: "closure" | "stop",
  parts: readonly string[],
): string {
  return join(absolute(source.directory), `${itemKey([kind, ...parts])}.json`);
}
