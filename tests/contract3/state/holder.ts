// Test-owned coordination lock holder (Linux expectations 4.2). Written from
// DESIGN.md section 7 and the Linux expectations, independently of the
// add-on's coordination module, like the test-owned record reader. It never
// imports the add-on.
//
// - Darwin: the numeric O_EXLOCK flag at open, as the frozen cases did.
// - Linux (glibc): flock(LOCK_EX | LOCK_NB) through the test's own foreign
//   call.
// - Negative controls (expectations 4.5): lockf(F_TLOCK), a POSIX record
//   lock owned by the process, which fails C4a and C4c by mechanism; and a
//   holder that hands its locked descriptor to a child, which fails C4b.
//   (A close-on-exec-cleared twin cannot fail through Bun.spawn, which
//   passes no descriptor beyond stdio; DESIGN.md section 7.)
import { dlopen, read } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";

const linux = process.platform === "linux";
const darwin = process.platform === "darwin";
const library = linux ? "libc.so.6" : "libSystem.B.dylib";
// Independent oracle: the C constants restated from <sys/file.h>,
// <unistd.h> and <errno.h>, not taken from the add-on.
const lockExclusive = 2; // LOCK_EX
const lockNonBlocking = 4; // LOCK_NB
const testLock = 2; // F_TLOCK
const contention: readonly number[] = linux ? [11, 13] : [35, 13]; // EAGAIN, EACCES

type Calls = {
  readonly flock: (fd: number, operation: number) => number;
  readonly lockf: (fd: number, command: number, length: bigint) => number;
  readonly errno: () => number;
};

function errnoReader(location: () => unknown): () => number {
  return () => {
    const pointer = location();
    return typeof pointer === "number" && pointer !== 0
      ? read.i32(pointer, 0)
      : -1;
  };
}

function loadLinux(): Calls {
  const { symbols } = dlopen(library, {
    flock: { args: ["i32", "i32"], returns: "i32" },
    lockf: { args: ["i32", "i32", "i64"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
  return {
    flock: (fd, operation) => symbols.flock(fd, operation),
    lockf: (fd, command, length) => symbols.lockf(fd, command, length),
    errno: errnoReader(() => symbols.__errno_location()),
  };
}

function loadDarwin(): Calls {
  const { symbols } = dlopen(library, {
    flock: { args: ["i32", "i32"], returns: "i32" },
    lockf: { args: ["i32", "i32", "i64"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
  return {
    flock: (fd, operation) => symbols.flock(fd, operation),
    lockf: (fd, command, length) => symbols.lockf(fd, command, length),
    errno: errnoReader(() => symbols.__error()),
  };
}

function load(): Calls | undefined {
  try {
    if (linux) return loadLinux();
    if (darwin) return loadDarwin();
  } catch {
    // No C library this test can call: no test route.
  }
  return undefined;
}

const calls = load();

// Whether this platform has a coordination route the cases may expect:
// Darwin, or a Linux whose C library gives this test its own working flock
// (flock(-1) refuses with EBADF, 9). Anything else runs the fail-closed
// control under an UNPROVED title.
export const coordinationExpected: boolean =
  darwin ||
  (linux &&
    calls !== undefined &&
    calls.flock(-1, lockExclusive | lockNonBlocking) === -1 &&
    calls.errno() === 9);

export type Held = { readonly fd: number; readonly release: () => void };
export type Attempt =
  | { readonly kind: "acquired"; readonly held: Held }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "error"; readonly code: string };

function codeOf(error: unknown): string {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

function held(fd: number): Held {
  let open = true;
  return {
    fd,
    release() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

function fromCall(fd: number, result: number): Attempt {
  if (result === 0) return { kind: "acquired", held: held(fd) };
  const errno = calls?.errno() ?? -1;
  closeSync(fd);
  return contention.includes(errno)
    ? { kind: "refused", code: `errno-${errno}` }
    : { kind: "error", code: `errno-${errno}` };
}

const plainFlags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;

// One non-blocking attempt with the platform's qualified primitive.
export function attemptLock(path: string): Attempt {
  if (darwin) {
    try {
      const fd = openSync(
        path,
        plainFlags | constants.O_NONBLOCK | 0x20, // O_EXLOCK
        0o600,
      );
      return { kind: "acquired", held: held(fd) };
    } catch (error) {
      const code = codeOf(error);
      return code === "EAGAIN" || code === "EWOULDBLOCK"
        ? { kind: "refused", code }
        : { kind: "error", code };
    }
  }
  if (!calls) return { kind: "error", code: "no-test-route" };
  const fd = openSync(path, plainFlags, 0o600);
  return fromCall(fd, calls.flock(fd, lockExclusive | lockNonBlocking));
}

// Negative control: a POSIX record lock (lockf F_TLOCK, whole file).
export function attemptPosixLock(path: string): Attempt {
  if (!calls) return { kind: "error", code: "no-test-route" };
  const fd = openSync(path, plainFlags, 0o600);
  return fromCall(fd, calls.lockf(fd, testLock, 0n));
}

// Holds the coordination lock on `path`; throws when it is not acquired.
export function holdLock(path: string): () => void {
  const attempt = attemptLock(path);
  if (attempt.kind !== "acquired")
    throw new Error(`Test holder did not acquire ${path}: ${attempt.code}.`);
  return attempt.held.release;
}

// True when the coordination lock on `path` is free right now.
export function lockFree(path: string): boolean {
  const attempt = attemptLock(path);
  if (attempt.kind === "acquired") attempt.held.release();
  return attempt.kind === "acquired";
}
