import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode } from "./read.ts";
import { ApprovalRejection } from "./rejection.ts";

// Atomic consumption primitive: exclusive creation (O_CREAT|O_EXCL) of one
// marker per authority item, then fsync of the marker and its directory
// before consumption returns. Exclusive creation is atomic across processes
// on a local POSIX filesystem, so two contenders can never both create the
// marker even if coordination were wrong. Any directory entry at the marker
// path, including an empty, torn, directory or symlink entry, means
// consumed: ambiguity never becomes reusable authority. The fsyncs are
// source-reviewed, not test-proved: process-crash evidence cannot observe a
// missing flush, and nothing here claims power-loss durability (CMD-11).

export function itemKey(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function markerPath(directory: string, key: string): string {
  return join(directory, `${key}.consumed`);
}

// Non-consuming inspection for preflight.
export async function isConsumed(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new ApprovalRejection("store-unavailable", error);
  }
}

// Returns false when another contender (or an earlier run) consumed first.
// Rejects as store-unavailable when nothing was created, and as
// durability-unconfirmed (consumed) once the marker exists.
export async function consumeOnce(
  path: string,
  record: string,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(
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
  // The marker exists from here on: every later failure, including a failing
  // close, is reported as consumed.
  let failure: { readonly error: unknown } | undefined;
  try {
    await handle.writeFile(record);
    await handle.sync();
  } catch (error) {
    failure = { error };
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= { error };
  }
  if (failure)
    throw new ApprovalRejection("durability-unconfirmed", failure.error);
  await syncDirectory(dirname(path));
  return true;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new ApprovalRejection("durability-unconfirmed", error);
  }
}
