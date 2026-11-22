import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { ApprovalRejection } from "./rejection.ts";

export type RecordFacts = {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
};

const limitBytes = 16 * 1024;
const depthLimit = 8;

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function isAbsentOrSymlinkOpenError(code: string | undefined): boolean {
  return code === "ENOENT" || code === "ELOOP" || code === "EMLINK";
}

export async function readUntrusted(
  path: string,
): Promise<
  { readonly value: unknown; readonly facts: RecordFacts } | undefined
> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isAbsentOrSymlinkOpenError(errorCode(error))) return undefined;
    throw new ApprovalRejection("store-unavailable", error);
  }
  try {
    const read = await boundedBytes(handle, path);
    const value = read && decode(read.bytes);
    return read && value
      ? { value: value.parsed, facts: read.facts }
      : undefined;
  } finally {
    await handle.close();
  }
}

async function boundedBytes(handle: FileHandle, path: string) {
  let length = 0;
  const buffer = new Uint8Array(limitBytes + 1);
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.nlink !== 1 || status.size > limitBytes)
      return undefined;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > limitBytes) return undefined;
    }
    const { uid, gid, mode, dev, ino } = status;
    return {
      bytes: buffer.subarray(0, length),
      facts: { path, uid, gid, mode, dev, ino },
    };
  } catch (error) {
    throw new ApprovalRejection("store-unavailable", error);
  }
}

function decode(bytes: Uint8Array): { readonly parsed: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
  return withinDepth(parsed, 0) ? { parsed } : undefined;
}

function withinDepth(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (depth >= depthLimit) return false;
  const items: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return items.every((item) => withinDepth(item, depth + 1));
}
