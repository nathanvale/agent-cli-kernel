import { dlopen, FFIType, ptr } from "bun:ffi";

const rlimitCore = 4;
const libc = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";

// Platform: a hosted ubuntu runner pipes core dumps to systemd-coredump with
// no core limit, and an aborted Bun child is reported gone only after about
// 20 s there (40 to 60 ms with the limit at 0; throwaway PR #44). A planted
// abort is about the exit, not the dump, so it turns the dump off first.
export function turnCoreDumpsOff(): void {
  const { symbols } = dlopen(libc, {
    setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  if (symbols.setrlimit(rlimitCore, ptr(new BigUint64Array(2))) !== 0)
    throw new Error("setrlimit(RLIMIT_CORE, 0) failed before a planted abort.");
}

export function abortWithoutCoreDump(): never {
  turnCoreDumpsOff();
  process.abort();
}
