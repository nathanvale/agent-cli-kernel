// Coordination locks (DESIGN.md section 7). Darwin numeric O_EXLOCK taken at
// open time, non-blocking, released by the kernel when the descriptor
// closes (including SIGKILL). Lock files are permanent: never truncated,
// unlinked or renamed, so every contender locks the same inode.
import { closeSync, constants, openSync } from "node:fs";

// <sys/fcntl.h>: O_EXLOCK 0x00000020. Only Darwin gives it lock meaning.
const darwinExclusiveLock = 0x20;

export function coordinationAvailable(): boolean {
  return process.platform === "darwin";
}

export type LockAttempt =
  | { readonly kind: "held"; readonly release: () => void }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly code: string };

// One non-blocking attempt. `create` false refuses a missing file instead of
// creating it (used for an existing owner lease).
export function tryLock(path: string, create = true): LockAttempt {
  if (!coordinationAvailable()) return { kind: "failed", code: "UNSUPPORTED" };
  const flags =
    constants.O_RDWR |
    constants.O_NONBLOCK |
    constants.O_NOFOLLOW |
    darwinExclusiveLock |
    (create ? constants.O_CREAT : 0);
  let descriptor: number;
  try {
    descriptor = openSync(path, flags, 0o600);
  } catch (error) {
    const code = errorCode(error);
    return code === "EAGAIN" || code === "EWOULDBLOCK"
      ? { kind: "busy" }
      : { kind: "failed", code };
  }
  let open = true;
  return {
    kind: "held",
    release() {
      if (!open) return;
      open = false;
      try {
        closeSync(descriptor);
      } catch {
        // The kernel still releases the lock when the process ends.
      }
    },
  };
}

// Bounded wait: polls every `interval` ms until acquired, failed or the
// bound passes. Never waits on an unbounded condition (CMD-12).
export async function waitLock(
  path: string,
  boundMilliseconds: number,
  intervalMilliseconds = 10,
): Promise<LockAttempt> {
  const until = performance.now() + boundMilliseconds;
  for (;;) {
    const attempt = tryLock(path);
    if (attempt.kind !== "busy" || performance.now() >= until) return attempt;
    await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds));
  }
}

export function errorCode(error: unknown): string {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}
