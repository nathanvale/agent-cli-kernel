export type Grant = {
  readonly operation: string;
  readonly preview: string;
  readonly authority: string;
  readonly resource: string;
  readonly resourceRevision: string;
  readonly effects: readonly string[];
  readonly expiresAt: number;
};
export type ClosureItem = {
  readonly operation: string;
  readonly disposition: "outcome-unknown";
  readonly evidence: string;
  readonly scope: string;
};
export type StopItem = {
  readonly operation: string;
  readonly owner: string;
  readonly writers: readonly string[];
  readonly scope: string;
  readonly liveConflict: boolean;
};

const formats = {
  approval: "contract3.approval-grant",
  closure: "contract3.closure-authority",
  stop: "contract3.stop-attestation",
} as const;

function fields(
  value: unknown,
  format: string,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const expected = ["format", "version", ...keys, "expiresAt"].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    return undefined;
  const map = new Map<string, unknown>(Object.entries(value));
  return map.get("format") === format && map.get("version") === 1
    ? map
    : undefined;
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ? value
    : undefined;
}

function identitySet(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    return undefined;
  const items: unknown[] = value;
  const valid = items.flatMap((item) => {
    const checked = identity(item);
    return checked === undefined ? [] : [checked];
  });
  return valid.length === items.length && new Set(valid).size === valid.length
    ? valid.sort()
    : undefined;
}

function expiry(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function parseGrant(value: unknown): Grant | undefined {
  const map = fields(value, formats.approval, [
    "operation",
    "preview",
    "authority",
    "resource",
    "resourceRevision",
    "effects",
  ]);
  if (!map) return undefined;
  const operation = identity(map.get("operation"));
  const preview = identity(map.get("preview"));
  const authority = identity(map.get("authority"));
  const resource = identity(map.get("resource"));
  const resourceRevision = identity(map.get("resourceRevision"));
  const effects = identitySet(map.get("effects"));
  const expiresAt = expiry(map.get("expiresAt"));
  return operation &&
    preview &&
    authority &&
    resource &&
    resourceRevision &&
    effects &&
    expiresAt
    ? {
        operation,
        preview,
        authority,
        resource,
        resourceRevision,
        effects,
        expiresAt,
      }
    : undefined;
}

export function parseClosure(
  value: unknown,
): (ClosureItem & { readonly expiresAt: number }) | undefined {
  const map = fields(value, formats.closure, [
    "operation",
    "disposition",
    "evidence",
    "scope",
  ]);
  if (!map || map.get("disposition") !== "outcome-unknown") return undefined;
  const operation = identity(map.get("operation"));
  const evidence = identity(map.get("evidence"));
  const scope = identity(map.get("scope"));
  const expiresAt = expiry(map.get("expiresAt"));
  return operation && evidence && scope && expiresAt
    ? {
        operation,
        disposition: "outcome-unknown",
        evidence,
        scope,
        expiresAt,
      }
    : undefined;
}

export function parseStop(
  value: unknown,
):
  | (Omit<StopItem, "liveConflict"> & { readonly expiresAt: number })
  | undefined {
  const map = fields(value, formats.stop, [
    "operation",
    "owner",
    "writers",
    "scope",
  ]);
  if (!map) return undefined;
  const operation = identity(map.get("operation"));
  const owner = identity(map.get("owner"));
  const writers = identitySet(map.get("writers"));
  const scope = identity(map.get("scope"));
  const expiresAt = expiry(map.get("expiresAt"));
  return operation && owner && writers && scope && expiresAt
    ? { operation, owner, writers, scope, expiresAt }
    : undefined;
}

export function sameSet(bound: readonly string[], current: unknown): boolean {
  const checked = identitySet(current);
  return (
    checked !== undefined &&
    checked.length === bound.length &&
    checked.every((item, index) => item === bound[index])
  );
}
