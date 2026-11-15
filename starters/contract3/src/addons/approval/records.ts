// Strict parsers for untrusted authority records. Shape validation is not
// authorisation: every parsed record is still matched against the exact
// current item, its expiry and its consumption state.

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
  // A live writer observed under coordination always refuses (REC-7a).
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
  return map.get("format") === format &&
    map.get("version") === 1 &&
    expiry(map.get("expiresAt")) !== undefined
    ? map
    : undefined;
}

export function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ? value
    : undefined;
}

export function identitySet(value: unknown): readonly string[] | undefined {
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

function text(map: ReadonlyMap<string, unknown>, key: string): string {
  // fields() admitted the exact key set; identity() rejects anything else.
  return identity(map.get(key)) ?? "";
}

function allIdentities(
  map: ReadonlyMap<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => identity(map.get(key)) !== undefined);
}

export function parseGrant(value: unknown): Grant | undefined {
  const keys = [
    "operation",
    "preview",
    "authority",
    "resource",
    "resourceRevision",
  ];
  const map = fields(value, formats.approval, [...keys, "effects"]);
  const effects = map && identitySet(map.get("effects"));
  const expiresAt = map && expiry(map.get("expiresAt"));
  if (!map || !allIdentities(map, keys) || !effects || !expiresAt)
    return undefined;
  return {
    operation: text(map, "operation"),
    preview: text(map, "preview"),
    authority: text(map, "authority"),
    resource: text(map, "resource"),
    resourceRevision: text(map, "resourceRevision"),
    effects,
    expiresAt,
  };
}

export function parseClosure(
  value: unknown,
): (ClosureItem & { readonly expiresAt: number }) | undefined {
  const keys = ["operation", "evidence", "scope"];
  const map = fields(value, formats.closure, [...keys, "disposition"]);
  const expiresAt = map && expiry(map.get("expiresAt"));
  if (
    !map ||
    !allIdentities(map, keys) ||
    !expiresAt ||
    map.get("disposition") !== "outcome-unknown"
  )
    return undefined;
  return {
    operation: text(map, "operation"),
    disposition: "outcome-unknown",
    evidence: text(map, "evidence"),
    scope: text(map, "scope"),
    expiresAt,
  };
}

export function parseStop(
  value: unknown,
):
  | (Omit<StopItem, "liveConflict"> & { readonly expiresAt: number })
  | undefined {
  const keys = ["operation", "owner", "scope"];
  const map = fields(value, formats.stop, [...keys, "writers"]);
  const writers = map && identitySet(map.get("writers"));
  const expiresAt = map && expiry(map.get("expiresAt"));
  if (!map || !allIdentities(map, keys) || !writers || !expiresAt)
    return undefined;
  return {
    operation: text(map, "operation"),
    owner: text(map, "owner"),
    writers,
    scope: text(map, "scope"),
    expiresAt,
  };
}

// Compares a caller-supplied list against a parsed, sorted, unique set.
export function sameSet(bound: readonly string[], current: unknown): boolean {
  const checked = identitySet(current);
  return (
    checked !== undefined &&
    checked.length === bound.length &&
    checked.every((item, index) => item === bound[index])
  );
}
