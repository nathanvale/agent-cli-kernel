import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode } from "../../shared/error-code.ts";
import { ApprovalRejection } from "./rejection.ts";

export function itemKey(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function markerPath(directory: string, key: string): string {
  return join(directory, `${key}.consumed`);
}

export async function isConsumed(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new ApprovalRejection("store-unavailable", error);
  }
}

export function consumeOnceSync(path: string, record: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw new ApprovalRejection("store-unavailable", error);
  }
  let failure: { readonly error: unknown } | undefined;
  try {
    const bytes = Buffer.from(record, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } catch (error) {
    failure = { error };
  }
  try {
    closeSync(descriptor);
  } catch (error) {
    failure ??= { error };
  }
  if (failure)
    throw new ApprovalRejection("durability-unconfirmed", failure.error);
  syncDirectorySync(dirname(path));
  return true;
}

function syncDirectorySync(directory: string): void {
  try {
    const descriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    throw new ApprovalRejection("durability-unconfirmed", error);
  }
}
