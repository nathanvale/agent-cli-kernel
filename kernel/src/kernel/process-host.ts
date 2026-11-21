import { closeSync, openSync, writeSync } from "node:fs";
import { ReadStream } from "node:tty";
import type {
  ProcessHost,
  StopSignal,
  TerminalAdapter,
} from "./process-types.ts";

const encoder = new TextEncoder();

function ttyTerminal(): TerminalAdapter {
  let fd: number | undefined;
  let reader: ReadStream | undefined;
  let entered = false;
  let lastLines = 0;

  function open(): number {
    if (fd === undefined) fd = openSync("/dev/tty", "r+");
    return fd;
  }

  function write(text: string): void {
    writeSync(open(), encoder.encode(text));
  }

  function leave(): void {
    const activeReader = reader;
    const activeFd = fd;
    reader = undefined;
    fd = undefined;
    const wasEntered = entered;
    entered = false;
    lastLines = 0;
    try {
      if (wasEntered) activeReader?.setRawMode(false);
    } catch {
      // Platform: Terminal restoration ignores a closed or revoked controlling tty.
    }
    try {
      if (wasEntered && activeFd !== undefined)
        writeSync(activeFd, encoder.encode("\x1b[?25h"));
    } catch {
      // Platform: Cursor restoration ignores a closed or revoked controlling tty.
    }
    try {
      activeReader?.destroy();
    } catch {
      // Platform: Destroying a closed tty stream can fail after detach.
    }
    if (activeFd !== undefined) {
      try {
        closeSync(activeFd);
      } catch {
        // Platform: Closing an already-closed fd on teardown is ignored.
      }
    }
  }

  return {
    size: () => ({
      columns: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    }),
    enter() {
      if (entered) return;
      const descriptor = open();
      reader ??= new ReadStream(descriptor);
      reader.setRawMode(true);
      entered = true;
      write("\x1b[?25l");
    },
    leave,
    keys(signal) {
      return {
        [Symbol.asyncIterator]() {
          const descriptor = open();
          const stream = (reader ??= new ReadStream(descriptor));
          const queued: Uint8Array[] = [];
          const waiters: ((value: IteratorResult<Uint8Array>) => void)[] = [];
          let closed = signal.aborted;

          const finish = () => {
            if (closed) return;
            closed = true;
            stream.off("data", onData);
            stream.off("end", finish);
            stream.off("close", finish);
            signal.removeEventListener("abort", finish);
            while (waiters.length > 0) {
              const resolve = waiters.shift();
              resolve?.({ done: true, value: undefined });
            }
          };

          const onData = (chunk: Buffer | string) => {
            if (closed) return;
            const bytes =
              typeof chunk === "string"
                ? encoder.encode(chunk)
                : new Uint8Array(chunk);
            const waiter = waiters.shift();
            if (waiter) waiter({ done: false, value: bytes });
            else queued.push(bytes);
          };

          if (!closed) {
            stream.on("data", onData);
            stream.on("end", finish);
            stream.on("close", finish);
            signal.addEventListener("abort", finish, { once: true });
          }

          return {
            next() {
              const next = queued.shift();
              if (next !== undefined)
                return Promise.resolve({ done: false, value: next });
              if (closed)
                return Promise.resolve({ done: true, value: undefined });
              return new Promise<IteratorResult<Uint8Array>>((resolve) => {
                waiters.push(resolve);
              });
            },
            return() {
              finish();
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
    },
    draw(lines) {
      const prefix =
        lastLines > 1 ? `\x1b[${String(lastLines - 1)}A\r\x1b[J` : "\r\x1b[J";
      write(`${prefix}${lines.join("\r\n")}`);
      lastLines = lines.length;
    },
  };
}

const current: {
  signal?: (signal: StopSignal) => void;
  crash?: (error: unknown) => void;
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
  process.on("uncaughtException", (error) => current.crash?.(error));
  process.on("unhandledRejection", (reason) => current.crash?.(reason));
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
    terminal() {
      return process.stdin.isTTY === true && process.stdout.isTTY === true
        ? ttyTerminal()
        : undefined;
    },
  };
}
