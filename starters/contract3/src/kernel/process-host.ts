import type { ProcessHost, StopSignal } from "./process-types.ts";

// The output owner's process adapter (GATE-12). It is the only kernel file
// that touches the process streams. Errors surface through the write result,
// never as an uncaught exception or a stderr dump.
export function processHost(): ProcessHost {
  const ignore = () => undefined;
  process.stdout.on("error", ignore);
  process.stderr.on("error", ignore);
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
      for (const signal of [
        "SIGINT",
        "SIGTERM",
      ] as const satisfies readonly StopSignal[])
        process.on(signal, () => listener(signal));
    },
    onCrash(listener) {
      process.on("uncaughtException", () => listener());
      process.on("unhandledRejection", () => listener());
    },
    now: () => performance.now(),
  };
}
