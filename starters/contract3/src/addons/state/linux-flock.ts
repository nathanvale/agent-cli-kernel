import { dlopen, read } from "bun:ffi";

export const glibc = "libc.so.6";
// Platform: <sys/file.h>
const lockExclusive = 2; // LOCK_EX
const lockNonBlocking = 4; // LOCK_NB
const flockOperation = lockExclusive | lockNonBlocking;
// Platform: <errno.h>, Linux. 11 is both EAGAIN and EWOULDBLOCK.
const errnoNames: Readonly<Record<number, string>> = {
  9: "EBADF",
  11: "EAGAIN",
  22: "EINVAL",
  37: "ENOLCK",
  38: "ENOSYS",
  95: "EOPNOTSUPP",
};
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

export type FlockCalls = {
  readonly flock: (fd: number, operation: number) => number;
  readonly errno: () => number | undefined;
};

function name(errno: number | undefined): string {
  return errno === undefined
    ? "an unreadable error code"
    : (errnoNames[errno] ?? `errno-${errno}`);
}

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
