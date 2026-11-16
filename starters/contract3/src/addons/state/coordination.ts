// Coordination locks (DESIGN.md section 7). One lock family on every
// supported platform: non-blocking, exclusive, owned by the open file
// description and released by the kernel when the descriptor closes
// (including SIGKILL). Darwin takes it at open time with numeric O_EXLOCK;
// Linux takes it with flock(LOCK_EX | LOCK_NB) after open (linux-flock.ts).
// Lock files are permanent: never truncated, unlinked or renamed, so every
// contender locks the same inode. No route ever falls back to a lock file,
// a lock age or an owner identity: an unavailable route refuses.
import { arch, release } from "node:os";
import { closeSync, constants, openSync } from "node:fs";
import { loadLinuxFlock } from "./linux-flock.ts";
import type { FlockResult } from "./linux-flock.ts";

// <sys/fcntl.h>: O_EXLOCK 0x00000020. Only Darwin gives it lock meaning.
const darwinExclusiveLock = 0x20;

const qualifiedScope =
  "qualified: darwin O_EXLOCK at open; linux glibc flock(LOCK_EX|LOCK_NB) through libc.so.6";

export type LockAttempt =
  | { readonly kind: "held"; readonly release: () => void }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly code: string };

export type CoordinationRoute =
  | {
      readonly available: true;
      // The route and the facts it was accepted on (N4: the scope actually
      // observed, reported by capabilities()).
      readonly scope: string;
      // One non-blocking attempt. `create` false refuses a missing file
      // instead of creating it (used for an existing owner lease).
      readonly tryLock: (path: string, create?: boolean) => LockAttempt;
    }
  | {
      readonly available: false;
      readonly reason:
        | "coordination-unqualified-platform"
        | "coordination-self-check-failed";
      // Observed facts and the qualified scope, for a person to act on.
      readonly detail: string;
    };

function facts(): string {
  return `platform ${process.platform} ${arch()}, kernel ${release()}`;
}

export function errorCode(error: unknown): string {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

function opened(descriptor: number): LockAttempt {
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

function darwinTryLock(path: string, create = true): LockAttempt {
  const flags =
    constants.O_RDWR |
    constants.O_NONBLOCK |
    constants.O_NOFOLLOW |
    darwinExclusiveLock |
    (create ? constants.O_CREAT : 0);
  try {
    return opened(openSync(path, flags, 0o600));
  } catch (error) {
    const code = errorCode(error);
    return code === "EAGAIN" || code === "EWOULDBLOCK"
      ? { kind: "busy" }
      : { kind: "failed", code };
  }
}

function flockTryLock(lock: (fd: number) => FlockResult) {
  return (path: string, create = true): LockAttempt => {
    const flags =
      constants.O_RDWR |
      constants.O_NOFOLLOW |
      (create ? constants.O_CREAT : 0);
    let descriptor: number;
    try {
      descriptor = openSync(path, flags, 0o600);
    } catch (error) {
      return { kind: "failed", code: errorCode(error) };
    }
    const result = lock(descriptor);
    if (result.kind === "held") return opened(descriptor);
    closeSync(descriptor);
    return result;
  };
}

// Production: the route for this platform, after its start-up self-check.
// `library` is set only by the labelled test entry (fixture.ts), to make the
// Linux self-check fail on purpose; it selects the Linux route on any
// platform.
export function resolveCoordination(library?: string): CoordinationRoute {
  if (library === undefined && process.platform === "darwin")
    return {
      available: true,
      scope: `darwin O_EXLOCK at open; ${facts()}`,
      tryLock: darwinTryLock,
    };
  if (library === undefined && process.platform !== "linux")
    return {
      available: false,
      reason: "coordination-unqualified-platform",
      detail: `${facts()}; no coordination route; ${qualifiedScope}`,
    };
  const loaded = loadLinuxFlock(library);
  if (!loaded.ok)
    return {
      available: false,
      reason: "coordination-self-check-failed",
      detail: `${facts()}; flock through ${loaded.library}: ${loaded.step}; ${qualifiedScope}`,
    };
  return {
    available: true,
    scope: `linux flock(LOCK_EX|LOCK_NB) through ${loaded.library}; ${facts()}; filesystem not checked`,
    tryLock: flockTryLock(loaded.lock),
  };
}

// Bounded wait: polls every `interval` ms until acquired, failed or the
// bound passes. Never waits on an unbounded condition (CMD-12).
export async function waitLock(
  tryLock: (path: string) => LockAttempt,
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
