import type { ProcessHost, StopSignal } from "./process-types.ts";

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
