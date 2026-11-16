// Linux coordination lock call (DESIGN.md section 7). The only module of the
// add-on that knows bun:ffi exists: the library name, the flock signature,
// the two constants and reading errno. Lint bans bun:ffi everywhere else in
// contract source. A lock is held only when flock returns 0, so a misread
// errno can only become a refusal, never an acquisition.
import { dlopen, read } from "bun:ffi";

export const glibc = "libc.so.6";
// <sys/file.h>
const lockExclusive = 2; // LOCK_EX
const lockNonBlocking = 4; // LOCK_NB
const flockOperation = lockExclusive | lockNonBlocking;
// <errno.h>, Linux. 11 is both EAGAIN and EWOULDBLOCK; one name, EAGAIN, is
// used here, in the probe and in DESIGN.md.
const errnoNames: Readonly<Record<number, string>> = {
  9: "EBADF",
  11: "EAGAIN",
  22: "EINVAL",
  37: "ENOLCK",
  38: "ENOSYS",
  95: "EOPNOTSUPP",
};
// Bound on a loader message carried into the refusal detail.
const loaderMessageCharacters = 160;

export type FlockResult =
  | { readonly kind: "held" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly code: string };

export type LinuxFlock =
  | {
      readonly ok: true;
      readonly library: string;
      readonly lock: (fd: number) => FlockResult;
    }
  | { readonly ok: false; readonly library: string; readonly step: string };

// The two foreign calls as plain functions. `errno` is undefined when the
// error slot cannot be read.
export type FlockCalls = {
  readonly flock: (fd: number, operation: number) => number;
  readonly errno: () => number | undefined;
};

function name(errno: number | undefined): string {
  return errno === undefined
    ? "an unreadable error code"
    : (errnoNames[errno] ?? `errno-${errno}`);
}

// The start-up self-check and the lock call, decided from the calls' return
// values alone: flock(-1, LOCK_EX | LOCK_NB) must return -1 with EBADF (9);
// anything else (0, another code, an unreadable code) fails it. It touches
// no file; it proves the binding and the error read, not the filesystem.
export function checkedFlock(library: string, calls: FlockCalls): LinuxFlock {
  const probe = calls.flock(-1, flockOperation);
  const probeError = probe === -1 ? calls.errno() : undefined;
  if (probe !== -1 || probeError !== 9)
    return {
      ok: false,
      library,
      step:
        probe === -1
          ? `flock(-1) returned -1 with ${name(probeError)}, expected -1 with EBADF`
          : `flock(-1) returned ${probe}, expected -1 with EBADF`,
    };
  return {
    ok: true,
    library,
    lock(fd) {
      if (calls.flock(fd, flockOperation) === 0) return { kind: "held" };
      const code = name(calls.errno());
      return code === "EAGAIN" ? { kind: "busy" } : { kind: "failed", code };
    },
  };
}

// Loads the call from the C library and runs checkedFlock. `library` is the
// production C library unless the labelled test entry names another.
export function loadLinuxFlock(library = glibc): LinuxFlock {
  let symbols;
  try {
    symbols = dlopen(library, {
      flock: { args: ["i32", "i32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    }).symbols;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      library,
      step: `load: ${reason.slice(0, loaderMessageCharacters)}`,
    };
  }
  const { flock, __errno_location: location } = symbols;
  return checkedFlock(library, {
    flock: (fd, operation) => flock(fd, operation),
    errno() {
      const pointer = location();
      return pointer === null || pointer === 0
        ? undefined
        : read.i32(pointer, 0);
    },
  });
}
