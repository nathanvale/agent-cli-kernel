import type { ProcessHost, StopSignal } from "./process-types.ts";

// One set of process listeners for the whole process. Each run replaces the
// current listener instead of adding another, so repeated runs never
// accumulate handlers.
const current: {
  signal?: (signal: StopSignal) => void;
  crash?: () => void;
} = {};
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const ignore = () => undefined;
  process.stdout.on("error", ignore);
  process.stderr.on("error", ignore);
  for (const signal of [
    "SIGINT",
    "SIGTERM",
  ] as const satisfies readonly StopSignal[])
    process.on(signal, () => current.signal?.(signal));
  process.on("uncaughtException", () => current.crash?.());
  process.on("unhandledRejection", () => current.crash?.());
}

// The output owner's process adapter (GATE-12). It is the only kernel file
// that touches the process streams. Errors surface through the write result,
// never as an uncaught exception or a stderr dump.
export function processHost(): ProcessHost {
  return {
    write(stream, bytes) {
      const target = stream === "stdout" ? process.stdout : process.stderr;
      return new Promise((resolve) => {
        try {
          target.write(bytes, (error) => resolve(!error));
        } catch {
          resolve(false);
        }
      });
    },
    exit(code) {
      process.exit(code);
    },
    onSignal(listener) {
      install();
      current.signal = listener;
    },
    onCrash(listener) {
      install();
      current.crash = listener;
    },
    now: () => performance.now(),
  };
}
