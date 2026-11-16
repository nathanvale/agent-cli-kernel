// Coordination locks (DESIGN.md section 7). One lock family on every
// supported platform: non-blocking, exclusive, owned by the open file
// description and released by the operating-system kernel when the
// descriptor closes (including SIGKILL). Darwin takes it at open time with numeric O_EXLOCK;
// Linux takes it with flock(LOCK_EX | LOCK_NB) after open (linux-flock.ts).
// Lock files are permanent: never truncated, unlinked or renamed, so every
// contender locks the same inode. No route ever falls back to a lock file,
// a lock age or an owner identity: an unavailable route refuses.
import { arch, release } from "node:os";
import { closeSync, constants, openSync } from "node:fs";
import { glibc, loadLinuxFlock } from "./linux-flock.ts";
import type { FlockResult } from "./linux-flock.ts";

// <sys/fcntl.h>: O_EXLOCK 0x00000020. Only Darwin gives it lock meaning.
const darwinExclusiveLock = 0x20;

// One description per route; the "qualified on" text is derived from them,
// so it cannot drift from the route actually used.
const routes = {
  darwin: "darwin O_EXLOCK at open",
  linux: (library: string) => `linux flock(LOCK_EX|LOCK_NB) through ${library}`,
} as const;
const qualifiedOn = `qualified on: ${routes.darwin}; ${routes.linux(glibc)}`;

export type LockAttempt =
  | { readonly kind: "held"; readonly release: () => void }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly code: string };

export type CoordinationRoute =
  | {
      readonly available: true;
      // The route and the facts it was accepted on (N4: what was actually
      // observed, reported by capabilities()).
      readonly basis: string;
      // One non-blocking attempt. `create` false refuses a missing file
      // instead of creating it (used for an existing owner lease).
      readonly tryLock: (path: string, create?: boolean) => LockAttempt;
    }
  | {
      readonly available: false;
      readonly reason:
        | "coordination-unqualified-platform"
        | "coordination-self-check-failed";
      // Observed facts and what is qualified, for a person to act on.
      readonly detail: string;
    };

function facts(): string {
  return `platform ${process.platform} ${arch()}, kernel release ${release()}`;
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
        // The operating system still releases it when the process ends.
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
    let result: FlockResult;
    try {
      result = lock(descriptor);
    } catch {
      // A throw after the call (reading errno) must never keep a descriptor
      // that holds no coordination lock.
      result = { kind: "failed", code: "flock-call-threw" };
    }
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
      basis: `${routes.darwin}; ${facts()}`,
      tryLock: darwinTryLock,
    };
  if (library === undefined && process.platform !== "linux")
    return {
      available: false,
      reason: "coordination-unqualified-platform",
      detail: `${facts()}; no coordination route; ${qualifiedOn}`,
    };
  const loaded = loadLinuxFlock(library);
  if (!loaded.ok)
    return {
      available: false,
      reason: "coordination-self-check-failed",
      detail: `${facts()}; ${routes.linux(loaded.library)}: ${loaded.step}; ${qualifiedOn}`,
    };
  return {
    available: true,
    basis: `${routes.linux(loaded.library)}; ${facts()}; filesystem not checked`,
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
