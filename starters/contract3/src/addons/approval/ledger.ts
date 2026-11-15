import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode, storeUnavailable } from "./read.ts";

// Atomic consumption primitive: exclusive creation (O_CREAT|O_EXCL) of one
// marker per authority item, then fsync of the marker and its directory
// before admission returns. Exclusive creation is atomic across processes
// on a local POSIX filesystem, so two contenders can never both create the
// marker even if coordination were wrong. Any directory entry at the marker
// path, including an empty, torn, directory or symlink entry, means
// consumed: ambiguity never becomes reusable authority. Evidence covers
// process crash and file flush only, never power loss (CMD-11).

export function itemKey(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function markerPath(ledger: string, key: string): string {
  return join(ledger, `${key}.consumed`);
}

// Non-consuming inspection for preflight.
export async function isConsumed(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw storeUnavailable();
  }
}

// Returns false when another contender (or an earlier run) consumed first.
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
    throw storeUnavailable();
  }
  try {
    await handle.writeFile(record);
    await handle.sync();
  } catch {
    // The marker exists, so the item stays consumed; no effect may start.
    throw storeUnavailable();
  } finally {
    await handle.close();
  }
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
  } catch {
    throw storeUnavailable();
  }
}
