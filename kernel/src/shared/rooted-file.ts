import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type RootedRefusal = {
  readonly kind: "refused";
  readonly path: string;
  readonly message: string;
  readonly reason:
    | "outside-root"
    | "symbolic-link"
    | "linked-folder"
    | "hard-link"
    | "not-regular"
    | "over-limit";
};

export type RootedFacts = {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
};

type OpenedStats = {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly nlink: number;
};

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !Object.hasOwn(error, "code"))
    return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function refusal(
  path: string,
  reason: RootedRefusal["reason"],
  message: string,
): RootedRefusal {
  return { kind: "refused", path, reason, message };
}

function lstatOptional(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function realpathOptional(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function withinRoot(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return undefined;
  return rel;
}

function resolveRealRoot(root: string):
  | {
      readonly kind: "ok";
      readonly resolvedRoot: string;
      readonly realRoot: string;
    }
  | { readonly kind: "missing" }
  | RootedRefusal {
  const realRoot = realpathOptional(root);
  if (realRoot === undefined) return { kind: "missing" };
  const status = lstatOptional(realRoot);
  if (status === undefined) return { kind: "missing" };
  if (!status.isDirectory())
    return refusal(
      root,
      "not-regular",
      `${root} is not a folder. Repair: pass an existing folder as the root.`,
    );
  const lexicalRoot = resolve(root);
  const resolvedRoot =
    realpathOptional(lexicalRoot) === realRoot ? lexicalRoot : realRoot;
  return { kind: "ok", resolvedRoot, realRoot };
}

function relativeInside(
  resolvedRoot: string,
  realRoot: string,
  path: string,
): string | RootedRefusal {
  const rel = isAbsolute(path)
    ? (withinRoot(resolvedRoot, resolve(path)) ??
      withinRoot(realRoot, resolve(path)))
    : withinRoot(realRoot, resolve(realRoot, path));
  if (rel === undefined)
    return refusal(
      path,
      "outside-root",
      `${path} is outside root ${realRoot}. Repair: pass a path inside ${realRoot}.`,
    );
  if (rel === "")
    return refusal(
      path,
      "not-regular",
      `${path} is the root folder, not a regular file. Repair: pass a file path inside ${realRoot}.`,
    );
  return rel;
}

function checkParentSteps(
  realRoot: string,
  path: string,
): { readonly kind: "ok" } | { readonly kind: "missing" } | RootedRefusal {
  const given = isAbsolute(path) ? path : `${realRoot}${sep}${path}`;
  const segments = given.split(sep);
  for (const [index, segment] of segments.entries()) {
    if (segment !== "..") continue;
    const before = segments.slice(0, index).join(sep) || sep;
    const physical = realpathOptional(before);
    const lexical = realpathOptional(resolve(before, ".."));
    if (physical === undefined || lexical === undefined)
      return { kind: "missing" };
    if (dirname(physical) !== lexical)
      return refusal(
        path,
        "linked-folder",
        `${path} steps to ".." from linked folder ${before}, which leaves the written path. Repair: pass the path without "..", or replace the symbolic link with a real folder inside ${realRoot}.`,
      );
  }
  return { kind: "ok" };
}

function walkAncestors(
  realRoot: string,
  parentSegments: readonly string[],
  originalPath: string,
): { readonly kind: "ok" } | { readonly kind: "missing" } | RootedRefusal {
  let current = realRoot;
  for (const segment of parentSegments) {
    current = join(current, segment);
    const entry = lstatOptional(current);
    if (entry === undefined) return { kind: "missing" };
    if (entry.isSymbolicLink())
      return refusal(
        originalPath,
        "linked-folder",
        `${originalPath} crosses linked folder ${current}. Repair: replace the symbolic link with a real folder inside ${realRoot}.`,
      );
    if (!entry.isDirectory())
      return refusal(
        originalPath,
        "not-regular",
        `${originalPath} has non-folder ancestor ${current}. Repair: pass a file path whose parent levels are folders.`,
      );
  }
  return { kind: "ok" };
}

function openNoFollow(
  targetPath: string,
  realRoot: string,
  originalPath: string,
):
  | { readonly kind: "fd"; readonly fd: number }
  | { readonly kind: "missing" }
  | RootedRefusal {
  try {
    const fd = openSync(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    return { kind: "fd", fd };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP" || code === "EMLINK")
      return refusal(
        originalPath,
        "symbolic-link",
        `${originalPath} is a symbolic link. Repair: replace the link with a regular file inside ${realRoot}.`,
      );
    if (code === "EISDIR")
      return refusal(
        originalPath,
        "not-regular",
        `${originalPath} is not a regular file. Repair: replace it with a regular file inside ${realRoot}.`,
      );
    throw error;
  }
}

function checkDescriptor(
  fd: number,
  realRoot: string,
  originalPath: string,
  limitBytes: number,
): { readonly kind: "ok"; readonly status: OpenedStats } | RootedRefusal {
  const status = fstatSync(fd);
  if (!status.isFile())
    return refusal(
      originalPath,
      "not-regular",
      `${originalPath} is not a regular file. Repair: replace it with a regular file inside ${realRoot}.`,
    );
  if (status.nlink !== 1)
    return refusal(
      originalPath,
      "hard-link",
      `${originalPath} is a hard link (link count ${String(status.nlink)}). Repair: replace it with a copy, or remove the other link.`,
    );
  if (status.size > limitBytes)
    return refusal(
      originalPath,
      "over-limit",
      `${originalPath} is ${String(status.size)} bytes, above the ${String(limitBytes)} byte limit. Repair: reduce the file size to at most ${String(limitBytes)} bytes.`,
    );
  return { kind: "ok", status };
}

function recheckOpened(
  status: OpenedStats,
  targetPath: string,
  parentPath: string,
  realRoot: string,
  originalPath: string,
): { readonly kind: "ok" } | { readonly kind: "missing" } | RootedRefusal {
  const entry = lstatOptional(targetPath);
  if (entry === undefined) return { kind: "missing" };
  if (entry.isSymbolicLink())
    return refusal(
      originalPath,
      "symbolic-link",
      `${originalPath} is a symbolic link. Repair: replace the link with a regular file inside ${realRoot}.`,
    );
  if (entry.dev !== status.dev || entry.ino !== status.ino)
    return refusal(
      originalPath,
      "outside-root",
      `${originalPath} changed between open and verification. Repair: retry once nothing is replacing the path.`,
    );
  const currentParent = realpathOptional(parentPath);
  if (currentParent === undefined) return { kind: "missing" };
  if (currentParent !== parentPath)
    return refusal(
      originalPath,
      "linked-folder",
      `${originalPath} parent folder ${parentPath} changed to a symbolic link. Repair: replace the symbolic link with a real folder inside ${realRoot}.`,
    );
  return { kind: "ok" };
}

function readBounded(
  fd: number,
  originalPath: string,
  limitBytes: number,
): Uint8Array | RootedRefusal {
  const buffer = new Uint8Array(limitBytes + 1);
  let length = 0;
  for (;;) {
    const bytesRead = readSync(
      fd,
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
    if (length > limitBytes)
      return refusal(
        originalPath,
        "over-limit",
        `${originalPath} exceeded the ${String(limitBytes)} byte limit while reading. Repair: reduce the file size to at most ${String(limitBytes)} bytes.`,
      );
  }
  return buffer.subarray(0, length);
}

export function readRootedFile(
  root: string,
  path: string,
  limitBytes: number,
  seam?: { readonly afterOpen?: () => void },
):
  | {
      readonly kind: "read";
      readonly bytes: Uint8Array;
      readonly facts: RootedFacts;
    }
  | { readonly kind: "missing" }
  | RootedRefusal {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0)
    throw new RangeError(
      `Rooted file limit must be a non-negative integer, got ${String(limitBytes)}.`,
    );
  const resolved = resolveRealRoot(root);
  if (resolved.kind !== "ok") return resolved;
  const { resolvedRoot, realRoot } = resolved;
  const rel = relativeInside(resolvedRoot, realRoot, path);
  if (typeof rel !== "string") return rel;
  const stepped = checkParentSteps(realRoot, path);
  if (stepped.kind !== "ok") return stepped;
  const segments = rel.split(sep);
  const parentSegments = segments.slice(0, -1);
  const walked = walkAncestors(realRoot, parentSegments, path);
  if (walked.kind !== "ok") return walked;
  const targetPath = join(realRoot, ...segments);
  const parentPath = join(realRoot, ...parentSegments);
  const opened = openNoFollow(targetPath, realRoot, path);
  if (opened.kind !== "fd") return opened;
  try {
    const checked = checkDescriptor(opened.fd, realRoot, path, limitBytes);
    if (checked.kind !== "ok") return checked;
    seam?.afterOpen?.();
    const rechecked = recheckOpened(
      checked.status,
      targetPath,
      parentPath,
      realRoot,
      path,
    );
    if (rechecked.kind !== "ok") return rechecked;
    const bytes = readBounded(opened.fd, path, limitBytes);
    if (!(bytes instanceof Uint8Array)) return bytes;
    const { dev, ino, uid, gid, mode, size, mtimeMs } = checked.status;
    return {
      kind: "read",
      bytes,
      facts: { dev, ino, uid, gid, mode, size, mtimeMs },
    };
  } finally {
    closeSync(opened.fd);
  }
}
