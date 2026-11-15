import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

// Hardened read of one untrusted authority record (CMD-9a, CMD-15).
// "absent" and "invalid" become an ordinary denial. Any other I/O failure
// is an operational failure and rejects; it is never folded into a denial
// or an admission (coordinator A04 caution).
export type UntrustedRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: unknown };

const limitBytes = 16 * 1024;
const depthLimit = 8;
const absent = Object.freeze({ kind: "absent" as const });
const invalid = Object.freeze({ kind: "invalid" as const });

export function storeUnavailable(): Error {
  return new Error("Approval authority store is unavailable.");
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function readUntrusted(path: string): Promise<UntrustedRead> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return absent;
    // A symlink at the record location is a caller-controlled substitution.
    if (code === "ELOOP" || code === "EMLINK") return invalid;
    throw storeUnavailable();
  }
  try {
    const bytes = await boundedBytes(handle);
    return bytes ? decode(bytes) : invalid;
  } finally {
    await handle.close();
  }
}

async function boundedBytes(
  handle: FileHandle,
): Promise<Uint8Array | undefined> {
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
  } catch {
    throw storeUnavailable();
  }
  return buffer.subarray(0, length);
}

function decode(bytes: Uint8Array): UntrustedRead {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid;
  }
  return withinDepth(value, 0) ? { kind: "value", value } : invalid;
}

function withinDepth(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (depth >= depthLimit) return false;
  const items: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return items.every((item) => withinDepth(item, depth + 1));
}
