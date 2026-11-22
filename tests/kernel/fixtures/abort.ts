import { dlopen, FFIType, ptr } from "bun:ffi";

const rlimitCore = 4;
const libc = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";

// Platform: Hosted Ubuntu systemd-coredump holds aborted Bun exits for ~20 s
// unless RLIMIT_CORE is 0 (40 to 60 ms with the limit at 0).
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
