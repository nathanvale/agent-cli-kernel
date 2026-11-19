import { arch, release } from "node:os";
import { closeSync, constants, openSync } from "node:fs";
import { glibc, loadLinuxFlock } from "./linux-flock.ts";
import type { FlockResult } from "./linux-flock.ts";

// Platform: <sys/fcntl.h>: O_EXLOCK 0x00000020. Only Darwin gives it lock meaning.
const darwinExclusiveLock = 0x20;
// O_CLOEXEC, set by the route itself (accepted decision BN-03, 17 November
// 2026). Bun's node:fs leaves it off on 1.4.0 and 1.4.2 (observed) and sets
// it on 1.4.4, and a child started outside Bun.spawn inherits a descriptor
// without it and keeps the lock after its owner dies.
// Darwin <sys/fcntl.h>; Linux <asm-generic/fcntl.h>.
const darwinCloseOnExec = 0x01000000;
const linuxCloseOnExec = 0o2000000;

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
      readonly route: string;
      readonly basis: string;
      readonly tryLock: (path: string, create?: boolean) => LockAttempt;
    }
  | {
      readonly available: false;
      readonly reason:
        | "coordination-unqualified-platform"
        | "coordination-self-check-failed";
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
        return;
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
    darwinCloseOnExec |
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
      linuxCloseOnExec |
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
      result = { kind: "failed", code: "flock-call-threw" };
    }
    if (result.kind === "held") return opened(descriptor);
    closeSync(descriptor);
    return result;
  };
}

export function resolveCoordination(library?: string): CoordinationRoute {
  if (library === undefined && process.platform === "darwin")
    return {
      available: true,
      route: routes.darwin,
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
    route: routes.linux(loaded.library),
    basis: `${routes.linux(loaded.library)}; ${facts()}; filesystem not checked`,
    tryLock: flockTryLock(loaded.lock),
  };
}

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
