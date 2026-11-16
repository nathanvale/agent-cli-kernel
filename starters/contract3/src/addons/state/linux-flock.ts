// Linux coordination lock call (DESIGN.md section 7). The only module of the
// add-on that knows bun:ffi exists: the library name, the flock signature,
// the two constants and reading errno. Lint bans bun:ffi everywhere else in
// contract source. A lock is held only when flock returns 0, so a misread
// errno can only become a refusal, never an acquisition.
import { dlopen, read } from "bun:ffi";

const glibc = "libc.so.6";
// <sys/file.h>
const lockExclusive = 2; // LOCK_EX
const lockNonBlocking = 4; // LOCK_NB
// <errno.h>, Linux
const errnoNames: Readonly<Record<number, string>> = {
  9: "EBADF",
  11: "EWOULDBLOCK",
  22: "EINVAL",
  37: "ENOLCK",
  38: "ENOSYS",
  95: "EOPNOTSUPP",
};

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

function name(errno: number): string {
  return errnoNames[errno] ?? `errno-${errno}`;
}

// Loads the call and runs the start-up self-check: flock(-1, LOCK_EX |
// LOCK_NB) must fail with EBADF. It touches no file; it proves the binding
// and the error read, not the filesystem. `library` is the production C
// library unless the labelled test entry names another.
export function loadLinuxFlock(library = glibc): LinuxFlock {
  let calls;
  try {
    calls = dlopen(library, {
      flock: { args: ["i32", "i32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    }).symbols;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, library, step: `load: ${reason.slice(0, 160)}` };
  }
  const { flock, __errno_location: location } = calls;
  const errno = (): number => {
    const pointer = location();
    return pointer === null || pointer === 0 ? -1 : read.i32(pointer, 0);
  };
  const operation = lockExclusive | lockNonBlocking;
  const probe = flock(-1, operation);
  const probeError = probe === -1 ? errno() : 0;
  if (probe !== -1 || probeError !== 9)
    return {
      ok: false,
      library,
      step: `flock(-1) returned ${probe} with ${name(probeError)}, expected -1 with EBADF`,
    };
  return {
    ok: true,
    library,
    lock(fd) {
      if (flock(fd, operation) === 0) return { kind: "held" };
      const code = name(errno());
      return code === "EWOULDBLOCK"
        ? { kind: "busy" }
        : { kind: "failed", code };
    },
  };
}
