import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { errorCode } from "../../shared/error-code.ts";
import {
  readLinkStats as lstatSync,
  readLinkTarget as readlinkSync,
  readPathStats as statSync,
  resolveRealPath as realpathSync,
} from "./store.ts";

export type ResourceDeclaration =
  | { readonly resource: string; readonly path: string }
  | { readonly resource: string; readonly key: string };
export type ScopeDeclaration =
  | {
      readonly resources: readonly ResourceDeclaration[];
      readonly invariants?: readonly string[];
    }
  | { readonly unknown: true };

export type CanonicalScope = {
  readonly resources: readonly {
    readonly resource: string;
    readonly path?: string;
    readonly key?: string;
    readonly keys: readonly string[];
  }[];
  readonly invariants: readonly string[];
  readonly unknown: boolean;
  readonly keys: readonly string[];
};

const unknownScope: CanonicalScope = Object.freeze({
  resources: Object.freeze([]),
  invariants: Object.freeze([]),
  unknown: true,
  keys: Object.freeze([]),
});

function fold(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function identity(path: string): { dev: bigint; ino: bigint } {
  const stats = statSync(path, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

function missing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

type Attempt<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };
function attempt<T>(read: () => T): Attempt<T> {
  try {
    return { kind: "ok", value: read() };
  } catch (error) {
    return missing(error) ? { kind: "missing" } : { kind: "failed" };
  }
}

function existingKeys(real: string): readonly string[] {
  const self = identity(real);
  const parent = identity(dirname(real));
  return [
    `inode:${self.dev}:${self.ino}`,
    `name:${parent.dev}:${parent.ino}/${fold(basename(real))}`,
  ];
}

function linkTarget(path: string): Attempt<string | undefined> {
  return attempt(() =>
    lstatSync(path).isSymbolicLink()
      ? resolve(dirname(path), readlinkSync(path))
      : undefined,
  );
}

export function pathKeys(
  path: string,
  depth = 0,
): readonly string[] | undefined {
  if (!isAbsolute(path) || depth > 32 || path.includes("\0")) return undefined;
  const target = resolve(path);
  const real = attempt(() => existingKeys(realpathSync.native(target)));
  if (real.kind === "ok") return real.value;
  if (real.kind === "failed") return undefined;
  const link = linkTarget(target);
  if (link.kind === "failed") return undefined;
  if (link.kind === "ok" && link.value !== undefined)
    return pathKeys(link.value, depth + 1);
  return missingKeys(target, depth);
}

function missingKeys(
  target: string,
  depth: number,
): readonly string[] | undefined {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    rest.unshift(basename(current));
    if (parent === current) return undefined;
    const real = attempt(() => identity(realpathSync.native(parent)));
    if (real.kind === "ok")
      return [
        `name:${real.value.dev}:${real.value.ino}/${rest.map(fold).join(sep)}`,
      ];
    if (real.kind === "failed") return undefined;
    const link = linkTarget(parent);
    if (link.kind === "failed") return undefined;
    if (link.kind === "ok" && link.value !== undefined)
      return pathKeys(join(link.value, ...rest), depth + 1);
    current = parent;
  }
}

const textPattern = /^[\p{L}\p{N}._:/@+-]{1,256}$/u;

function resourceKeys(
  item: ResourceDeclaration,
): CanonicalScope["resources"][number] | undefined {
  if (!textPattern.test(item.resource)) return undefined;
  if ("path" in item) {
    const keys = pathKeys(item.path);
    return keys
      ? { resource: item.resource, path: item.path, keys }
      : undefined;
  }
  return textPattern.test(item.key)
    ? { resource: item.resource, key: item.key, keys: [`key:${item.key}`] }
    : undefined;
}

export function canonicalise(declaration: ScopeDeclaration): CanonicalScope {
  if ("unknown" in declaration || declaration.resources.length === 0)
    return unknownScope;
  const resources = declaration.resources.map(resourceKeys);
  const invariants = [...new Set(declaration.invariants ?? [])].sort();
  const known = resources.flatMap((item) => (item ? [item] : []));
  if (
    known.length !== resources.length ||
    !invariants.every((name) => textPattern.test(name))
  )
    return unknownScope;
  const all = new Set([
    ...known.flatMap((item) => item.keys),
    ...invariants.map((name) => `invariant:${name}`),
  ]);
  return {
    resources: known,
    invariants,
    unknown: false,
    keys: [...all].sort(),
  };
}

export type PlainResource =
  | { readonly kind: "path"; readonly resource: string; readonly path: string }
  | { readonly kind: "key"; readonly resource: string; readonly key: string };

export type PlainScope =
  | { readonly unknown: true }
  | {
      readonly unknown: false;
      readonly resources: readonly PlainResource[];
      readonly invariants: readonly string[];
    };

const plainUnknownScope: PlainScope = Object.freeze({ unknown: true });
const emptyStrings: readonly string[] = Object.freeze([]);

type OwnRead = { readonly present: boolean; readonly value: unknown };

type CachedRead = {
  ownPresent?: boolean;
  ownValue?: unknown;
  anyResolved?: boolean;
  anyValue?: unknown;
};

export type OnceReader = {
  readonly own: (
    source: object,
    key: string,
  ) => { readonly present: boolean; readonly value: unknown };
  readonly field: (source: object, key: string) => unknown;
  readonly anyOnce: (source: object, key: string) => unknown;
  readonly length: (source: readonly unknown[]) => number;
  readonly keys: (source: object) => readonly string[];
  readonly recordOwn: (
    source: object,
    key: string,
    present: boolean,
    value: unknown,
  ) => void;
};

export function createOnceReader(): OnceReader {
  const fields = new Map<object, Map<string, CachedRead>>();
  const lengths = new Map<object, number>();
  const keyLists = new Map<object, readonly string[]>();

  const slot = (source: object): Map<string, CachedRead> => {
    let table = fields.get(source);
    if (!table) {
      table = new Map<string, CachedRead>();
      fields.set(source, table);
    }
    return table;
  };

  const own = (source: object, key: string): OwnRead => {
    const table = slot(source);
    const cached = table.get(key);
    if (cached?.ownPresent !== undefined)
      return { present: cached.ownPresent, value: cached.ownValue };
    if (Object.hasOwn(source, key)) {
      const value: unknown = cached?.anyResolved
        ? cached.anyValue
        : Reflect.get(source, key);
      table.set(key, {
        ownPresent: true,
        ownValue: value,
        anyResolved: true,
        anyValue: value,
      });
      return { present: true, value };
    }
    const next: CachedRead = cached
      ? { ...cached, ownPresent: false, ownValue: undefined }
      : { ownPresent: false, ownValue: undefined };
    table.set(key, next);
    return { present: false, value: undefined };
  };

  const anyOnce = (source: object, key: string): unknown => {
    const table = slot(source);
    const cached = table.get(key);
    if (cached?.anyResolved) return cached.anyValue;
    const value: unknown = Reflect.get(source, key);
    const next: CachedRead = cached
      ? { ...cached, anyResolved: true, anyValue: value }
      : { anyResolved: true, anyValue: value };
    table.set(key, next);
    return value;
  };

  return {
    own,
    field: (source, key) => own(source, key).value,
    anyOnce,
    length: (source) => {
      const cached = lengths.get(source);
      if (cached !== undefined) return cached;
      const value = source.length;
      lengths.set(source, value);
      return value;
    },
    keys: (source) => {
      const cached = keyLists.get(source);
      if (cached) return cached;
      const value = Object.keys(source);
      keyLists.set(source, value);
      return value;
    },
    recordOwn: (source, key, present, value) => {
      const table = slot(source);
      const cached = table.get(key);
      table.set(
        key,
        present
          ? {
              ownPresent: true,
              ownValue: value,
              anyResolved: true,
              anyValue: value,
            }
          : cached
            ? { ...cached, ownPresent: false, ownValue: undefined }
            : { ownPresent: false, ownValue: undefined },
      );
    },
  };
}

function parsePlainResource(
  raw: object,
  reader: OnceReader,
): PlainResource | undefined {
  const resource = reader.field(raw, "resource");
  if (typeof resource !== "string") return undefined;
  const pathEntry = reader.own(raw, "path");
  const keyEntry = reader.own(raw, "key");
  if (pathEntry.present === keyEntry.present) return undefined;
  if (pathEntry.present) {
    return typeof pathEntry.value === "string"
      ? Object.freeze({ kind: "path", resource, path: pathEntry.value })
      : undefined;
  }
  return typeof keyEntry.value === "string"
    ? Object.freeze({ kind: "key", resource, key: keyEntry.value })
    : undefined;
}

function readPlainResource(
  raw: unknown,
  reader: OnceReader,
  cache: Map<object, PlainResource | undefined>,
): PlainResource | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  if (cache.has(raw)) return cache.get(raw);
  const parsed = parsePlainResource(raw, reader);
  cache.set(raw, parsed);
  return parsed;
}

function readPlainResources(
  rawResources: unknown,
  reader: OnceReader,
): readonly PlainResource[] | undefined {
  if (!Array.isArray(rawResources)) return undefined;
  const length = reader.length(rawResources);
  if (length === 0) return undefined;
  const cache = new Map<object, PlainResource | undefined>();
  const resources: PlainResource[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = readPlainResource(
      reader.field(rawResources, String(index)),
      reader,
      cache,
    );
    if (!item) return undefined;
    resources.push(item);
  }
  return Object.freeze(resources);
}

export function readPlainStrings(
  raw: unknown,
  reader: OnceReader,
): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const length = reader.length(raw);
  for (let index = 0; index < length; index += 1) {
    const item = reader.field(raw, String(index));
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return Object.freeze(out);
}

export function readPlainScope(raw: unknown, reader: OnceReader): PlainScope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return plainUnknownScope;
  if (reader.field(raw, "unknown") === true) return plainUnknownScope;
  const resources = readPlainResources(reader.field(raw, "resources"), reader);
  if (!resources) return plainUnknownScope;
  const rawInvariants = reader.field(raw, "invariants");
  const invariants =
    rawInvariants === undefined
      ? emptyStrings
      : readPlainStrings(rawInvariants, reader);
  if (invariants === undefined) return plainUnknownScope;
  return Object.freeze({
    unknown: false,
    resources,
    invariants,
  });
}

function plainResourceKeys(
  item: PlainResource,
): CanonicalScope["resources"][number] | undefined {
  if (!textPattern.test(item.resource)) return undefined;
  if (item.kind === "path") {
    const keys = pathKeys(item.path);
    return keys
      ? Object.freeze({
          resource: item.resource,
          path: item.path,
          keys: Object.freeze([...keys]),
        })
      : undefined;
  }
  return textPattern.test(item.key)
    ? Object.freeze({
        resource: item.resource,
        key: item.key,
        keys: Object.freeze([`key:${item.key}`]),
      })
    : undefined;
}

export function canonicalisePlain(plain: PlainScope): CanonicalScope {
  if (plain.unknown || plain.resources.length === 0) return unknownScope;
  const resources = plain.resources.map(plainResourceKeys);
  const invariants = Object.freeze([...new Set(plain.invariants)].sort());
  const known = resources.flatMap((item) => (item ? [item] : []));
  if (
    known.length !== resources.length ||
    !invariants.every((name) => textPattern.test(name))
  )
    return unknownScope;
  const all = new Set([
    ...known.flatMap((item) => item.keys),
    ...invariants.map((name) => `invariant:${name}`),
  ]);
  return Object.freeze({
    resources: Object.freeze(known),
    invariants,
    unknown: false,
    keys: Object.freeze([...all].sort()),
  });
}

export function currentKeys(
  scope: CanonicalScope,
): readonly string[] | undefined {
  if (scope.unknown) return undefined;
  const all = new Set(scope.keys);
  for (const item of scope.resources) {
    if (item.path === undefined) continue;
    const fresh = pathKeys(item.path);
    if (!fresh) return undefined;
    fresh.forEach((key) => all.add(key));
  }
  return [...all].sort();
}

export function conflicts(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  const set = new Set(left);
  return right.some((key) => set.has(key));
}

function declaredResourceToken(
  item: CanonicalScope["resources"][number],
): string | undefined {
  if (item.key !== undefined && item.path === undefined)
    return JSON.stringify(["key", item.resource, item.key]);
  if (item.path !== undefined && item.key === undefined)
    return JSON.stringify(["path", item.resource, resolve(item.path)]);
  return undefined;
}

function declaredScopeTokens(
  scope: CanonicalScope,
): ReadonlySet<string> | undefined {
  if (scope.unknown || scope.resources.length === 0) return undefined;
  const tokens = new Set<string>();
  for (const item of scope.resources) {
    const token = declaredResourceToken(item);
    if (token === undefined) return undefined;
    tokens.add(token);
  }
  for (const invariant of scope.invariants)
    tokens.add(JSON.stringify(["invariant", invariant]));
  return tokens;
}

export function coversDeclaredResources(
  superset: CanonicalScope,
  subset: CanonicalScope,
): boolean {
  const wider = declaredScopeTokens(superset);
  const narrower = declaredScopeTokens(subset);
  if (!wider || !narrower || narrower.size === 0) return false;
  for (const token of narrower) if (!wider.has(token)) return false;
  return true;
}
