// Conflict scope canonicalisation (REC-2, DESIGN.md section 6). Keys are
// compared by intersection; an unknown scope conflicts with everything.
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

// An attempt that distinguishes "absent" from "unknowable": `missing` for
// ENOENT or ENOTDIR, `failed` for any other error.
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

// Keys of an existing real path: its inode and its folded name in its parent.
function existingKeys(real: string): readonly string[] {
  const self = identity(real);
  const parent = identity(dirname(real));
  return [
    `inode:${self.dev}:${self.ino}`,
    `name:${parent.dev}:${parent.ino}/${fold(basename(real))}`,
  ];
}

// The target of `path` when it is a (dangling) symbolic link.
function linkTarget(path: string): Attempt<string | undefined> {
  return attempt(() =>
    lstatSync(path).isSymbolicLink()
      ? resolve(dirname(path), readlinkSync(path))
      : undefined,
  );
}

// Keys for one absolute path, or undefined when its identity is unknowable.
export function pathKeys(
  path: string,
  depth = 0,
): readonly string[] | undefined {
  if (!isAbsolute(path) || depth > 32 || path.includes("\0")) return undefined;
  const target = resolve(path);
  const real = attempt(() => realpathSync.native(target));
  if (real.kind === "ok") return existingKeys(real.value);
  if (real.kind === "failed") return undefined;
  // A dangling symbolic link names its target, not itself.
  const link = linkTarget(target);
  if (link.kind === "failed") return undefined;
  if (link.kind === "ok" && link.value !== undefined)
    return pathKeys(link.value, depth + 1);
  return missingKeys(target, depth);
}

// A path that does not exist: its nearest existing real ancestor's identity
// plus the folded remaining components.
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

// The stored keys plus a fresh resolution of every stored path, so a target
// created or renamed after the intent still conflicts. Unresolvable is
// unknown.
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
