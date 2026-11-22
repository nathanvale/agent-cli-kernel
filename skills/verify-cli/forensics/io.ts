import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { at, parsedJson } from "../helper/json.ts";

export const forensicsSchema = "verify-forensics/1";

export const forensicsLimits = {
  maxEntries: 1024,
  maxFileBytes: 16_777_216,
  maxPayloadBytes: 65_536,
  maxDiagnosticsLines: 2048,
} as const;

const headerPattern = /^C3S1 ([a-z-]{1,24}) (\d{10}) ([0-9a-f]{64})$/;
const nextRecordPattern = /(?:^|\n)C3S1 [a-z-]{1,24} \d{10} [0-9a-f]{64}\n/;
const midLinePattern = /[^\n]C3S1 [a-z-]{1,24} \d{10} [0-9a-f]{64}\n/;
export const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
export const lenientDecoder = new TextDecoder();
export const currentUid = process.getuid?.() ?? -1;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function lstatSafe(
  path: string,
):
  | { readonly kind: "ok"; readonly stats: Stats }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly reason: string } {
  try {
    return { kind: "ok", stats: lstatSync(path) };
  } catch (error) {
    return at(error, "code") === "ENOENT"
      ? { kind: "missing" }
      : { kind: "error", reason: errorText(error) };
  }
}

export function openRealDirectory(
  label: string,
  folder: string,
):
  | { readonly ok: true; readonly stats: Stats }
  | { readonly ok: false; readonly reason: string } {
  const stat = lstatSafe(folder);
  if (stat.kind === "missing")
    return { ok: false, reason: `${label} ${folder} does not exist.` };
  if (stat.kind === "error")
    return { ok: false, reason: `Cannot stat ${folder}: ${stat.reason}` };
  if (stat.stats.isSymbolicLink() || !stat.stats.isDirectory())
    return { ok: false, reason: `${label} ${folder} is not a real directory.` };
  return { ok: true, stats: stat.stats };
}

function listDirectoryBounded(path: string):
  | {
      readonly kind: "ok";
      readonly names: readonly string[];
      readonly total: number;
      readonly truncated: boolean;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly reason: string } {
  try {
    const all = readdirSync(path).sort();
    const truncated = all.length > forensicsLimits.maxEntries;
    return {
      kind: "ok",
      names: truncated ? all.slice(0, forensicsLimits.maxEntries) : all,
      total: all.length,
      truncated,
    };
  } catch (error) {
    return at(error, "code") === "ENOENT"
      ? { kind: "missing" }
      : { kind: "error", reason: errorText(error) };
  }
}

export function formatMode(stats: Stats): string {
  return `0o${(stats.mode & 0o7777).toString(8).padStart(4, "0")}`;
}

function statUnreadable(
  stats: Stats,
  path: string,
  limit: number,
): string | undefined {
  if (!stats.isFile()) return `${path} is not a regular file`;
  return stats.size > limit
    ? `${path} is ${String(stats.size)} bytes, over ${String(limit)}`
    : undefined;
}

function readBounded(
  descriptor: number,
  path: string,
  expectedSize: number,
  limit: number,
):
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string } {
  const cap = limit + 1;
  const target = Math.min(Math.max(expectedSize, 0) + 1, cap);
  const buffer = Buffer.alloc(target);
  let filled = 0;
  for (;;) {
    if (filled > limit)
      return {
        ok: false,
        reason: `${path} exceeded ${String(limit)} bytes while reading`,
      };
    if (filled === buffer.byteLength) {
      const extra = Buffer.alloc(cap - filled);
      const got = readSync(descriptor, extra, 0, extra.byteLength, null);
      if (got === 0) return { ok: true, bytes: buffer.subarray(0, filled) };
      if (filled + got > limit)
        return {
          ok: false,
          reason: `${path} exceeded ${String(limit)} bytes while reading`,
        };
      return {
        ok: true,
        bytes: Buffer.concat([
          buffer.subarray(0, filled),
          extra.subarray(0, got),
        ]),
      };
    }
    const got = readSync(
      descriptor,
      buffer,
      filled,
      buffer.byteLength - filled,
      null,
    );
    if (got === 0) return { ok: true, bytes: buffer.subarray(0, filled) };
    filled += got;
  }
}

export function readBytesNoFollow(
  path: string,
  limit: number = forensicsLimits.maxFileBytes,
):
  | { readonly kind: "read"; readonly bytes: Uint8Array; readonly stats: Stats }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string } {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollow,
    );
  } catch (error) {
    const code = at(error, "code");
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP")
      return { kind: "unreadable", reason: `${path} is a symbolic link` };
    return { kind: "unreadable", reason: errorText(error) };
  }
  try {
    const stats = fstatSync(descriptor);
    const problem = statUnreadable(stats, path, limit);
    if (problem !== undefined) return { kind: "unreadable", reason: problem };
    const loaded = readBounded(descriptor, path, stats.size, limit);
    if (!loaded.ok) return { kind: "unreadable", reason: loaded.reason };
    return { kind: "read", bytes: loaded.bytes, stats };
  } catch (error) {
    return { kind: "unreadable", reason: errorText(error) };
  } finally {
    closeSync(descriptor);
  }
}

export function openListedDirectory(
  label: string,
  folder: string,
):
  | {
      readonly ok: true;
      readonly stats: Stats;
      readonly names: readonly string[];
      readonly total: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: string } {
  const opened = openRealDirectory(label, folder);
  if (!opened.ok) return opened;
  const listed = listDirectoryBounded(folder);
  if (listed.kind !== "ok")
    return {
      ok: false,
      reason:
        listed.kind === "missing"
          ? `${label} ${folder} disappeared.`
          : `Cannot read ${folder}: ${listed.reason}`,
    };
  return {
    ok: true,
    stats: opened.stats,
    names: listed.names,
    total: listed.total,
    truncated: listed.truncated,
  };
}

export function plainRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

export function singleC3s1Record(
  bytes: Uint8Array,
  expectedKind: string,
): Readonly<Record<string, unknown>> | undefined {
  const parsed = parseC3s1Records(bytes);
  const first = parsed.records[0];
  if (!parsed.ok || parsed.tornTail || parsed.records.length !== 1)
    return undefined;
  return first?.kind === expectedKind ? first.payload : undefined;
}

export function textField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => (typeof item === "string" ? [item] : []))
    : [];
}

function sha256Record(kind: string, body: Uint8Array): string {
  return createHash("sha256").update(`${kind}\n`).update(body).digest("hex");
}

export type C3s1Record = {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type C3s1Parse =
  | {
      readonly ok: true;
      readonly records: readonly C3s1Record[];
      readonly tornTail: boolean;
      readonly tornOffset: number | null;
      readonly recordHiddenInTornTail: boolean;
    }
  | {
      readonly ok: false;
      readonly records: readonly C3s1Record[];
      readonly failureOffset: number;
    };

type FrameHeader = {
  readonly kind: string;
  readonly length: number;
  readonly digest: string;
  readonly bodyStart: number;
};

function decodeHeader(bytes: Uint8Array, offset: number): FrameHeader | null {
  const nl = bytes.indexOf(10, offset);
  if (nl === -1) return null;
  let line: string;
  try {
    line = fatalUtf8.decode(bytes.subarray(offset, nl));
  } catch {
    return null;
  }
  const match = headerPattern.exec(line);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const length = Number(match[2]);
  if (length > forensicsLimits.maxPayloadBytes) return null;
  return { kind: match[1], length, digest: match[3], bodyStart: nl + 1 };
}

function decodeBody(
  bytes: Uint8Array,
  frame: FrameHeader,
): { readonly record: C3s1Record; readonly nextOffset: number } | null {
  const end = frame.bodyStart + frame.length;
  if (end + 1 > bytes.byteLength || bytes[end] !== 10) return null;
  const slice = bytes.subarray(frame.bodyStart, end);
  if (sha256Record(frame.kind, slice) !== frame.digest) return null;
  let text: string;
  try {
    text = fatalUtf8.decode(slice);
  } catch {
    return null;
  }
  const object = plainRecord(parsedJson(text));
  if (!object || object.kind !== frame.kind || object.format !== 1) return null;
  return {
    record: { kind: frame.kind, payload: object },
    nextOffset: end + 1,
  };
}

export function parseC3s1Records(bytes: Uint8Array): C3s1Parse {
  const records: C3s1Record[] = [];
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const frame = decodeHeader(bytes, cursor);
    const decoded = frame === null ? null : decodeBody(bytes, frame);
    if (decoded !== null) {
      records.push(decoded.record);
      cursor = decoded.nextOffset;
      continue;
    }
    const nl = bytes.indexOf(10, cursor);
    const tail = bytes.subarray(nl === -1 ? bytes.byteLength : nl + 1);
    if (nextRecordPattern.test(lenientDecoder.decode(tail)))
      return { ok: false, records, failureOffset: cursor };
    return {
      ok: true,
      records,
      tornTail: true,
      tornOffset: cursor,
      recordHiddenInTornTail: midLinePattern.test(lenientDecoder.decode(bytes)),
    };
  }
  return {
    ok: true,
    records,
    tornTail: false,
    tornOffset: null,
    recordHiddenInTornTail: false,
  };
}
