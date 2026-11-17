import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode } from "./read.ts";
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
