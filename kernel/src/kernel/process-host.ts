import { openSync, writeSync } from "node:fs";
import { ReadStream } from "node:tty";
import type {
  ProcessHost,
  StopSignal,
  TerminalAdapter,
} from "./process-types.ts";

const encoder = new TextEncoder();
const maxQueuedChunks = 64;
const maxQueuedBytes = 65_536;

export type TtyStream = {
  setRawMode(mode: boolean): unknown;
  pause(): unknown;
  resume(): unknown;
  ref(): unknown;
  unref(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
};

export type TtyTerminalIo = {
  readonly size: () => { readonly columns: number; readonly rows: number };
  readonly openStream: () => TtyStream;
  readonly write: (bytes: Uint8Array) => void;
};

export function ttyTerminalFor(io: TtyTerminalIo): TerminalAdapter {
  let reader: TtyStream | undefined;
  let entered = false;
  let lastLines = 0;

  function ensureStream(): TtyStream {
    reader ??= io.openStream();
    return reader;
  }

  function write(text: string): void {
    io.write(encoder.encode(text));
  }

  function leave(): void {
    const activeReader = reader;
    const wasEntered = entered;
    entered = false;
    lastLines = 0;
    try {
      if (wasEntered) activeReader?.setRawMode(false);
    } catch {
      // Platform: Terminal restoration ignores a closed or revoked controlling tty.
    }
    try {
      if (wasEntered) io.write(encoder.encode("\x1b[?25h"));
    } catch {
      // Platform: Cursor restoration ignores a closed or revoked controlling tty.
    }
    try {
      // Platform: Reusing one paused, unref'd ReadStream across menus avoids
      // Bun 1.4.4's closeSync deadlock after destroy() and second-ReadStream
      // read starvation on /dev/tty.
      activeReader?.pause();
      activeReader?.unref();
    } catch {
      // Platform: Pausing a closed tty stream can fail after detach.
    }
  }

  return {
    size: () => io.size(),
    enter() {
      if (entered) return;
      const stream = ensureStream();
      stream.ref();
      stream.setRawMode(true);
      entered = true;
      write("\x1b[?25l");
    },
    leave,
    keys(signal) {
      return {
        [Symbol.asyncIterator]() {
          const stream = ensureStream();
          const queued: Uint8Array[] = [];
          let queuedBytes = 0;
          let backpressured = false;
          const waiters: ((value: IteratorResult<Uint8Array>) => void)[] = [];
          let closed = signal.aborted;

          const finish = () => {
            if (closed) return;
            closed = true;
            queued.length = 0;
            queuedBytes = 0;
            backpressured = false;
            stream.off("data", onData);
            stream.off("end", finish);
            stream.off("close", finish);
            signal.removeEventListener("abort", finish);
            try {
              stream.pause();
            } catch {
              // Platform: Pausing a closed tty stream can fail after detach.
            }
            while (waiters.length > 0) {
              const resolve = waiters.shift();
              resolve?.({ done: true, value: undefined });
            }
          };

          const pauseIfFull = () => {
            if (backpressured) return;
            if (
              queued.length >= maxQueuedChunks ||
              queuedBytes >= maxQueuedBytes
            ) {
              backpressured = true;
              stream.pause();
            }
          };

          const enqueue = (bytes: Uint8Array) => {
            const available = maxQueuedBytes - queuedBytes;
            if (queued.length < maxQueuedChunks && available > 0) {
              const accepted =
                bytes.byteLength <= available
                  ? bytes
                  : bytes.subarray(0, available);
              queued.push(accepted);
              queuedBytes += accepted.byteLength;
            }
            pauseIfFull();
          };

          const onData = (chunk: Buffer | string) => {
            if (closed) return;
            const bytes =
              typeof chunk === "string"
                ? encoder.encode(chunk)
                : new Uint8Array(chunk);
            if (bytes.byteLength === 0) return;
            const waiter = waiters.shift();
            if (waiter) {
              waiter({ done: false, value: bytes });
              return;
            }
            enqueue(bytes);
          };

          if (!closed) {
            stream.on("data", onData);
            stream.on("end", finish);
            stream.on("close", finish);
            signal.addEventListener("abort", finish, { once: true });
            stream.resume();
          }

          return {
            next() {
              if (closed || signal.aborted) {
                finish();
                return Promise.resolve({ done: true, value: undefined });
              }
              const next = queued.shift();
              if (next !== undefined) {
                queuedBytes -= next.byteLength;
                if (
                  backpressured &&
                  queued.length < maxQueuedChunks &&
                  queuedBytes < maxQueuedBytes
                ) {
                  backpressured = false;
                  stream.resume();
                }
                return Promise.resolve({ done: false, value: next });
              }
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

function ttyTerminal(): TerminalAdapter {
  let fd: number | undefined;
  function open(): number {
    if (fd === undefined) fd = openSync("/dev/tty", "r+");
    return fd;
  }
  return ttyTerminalFor({
    size: () => ({
      columns: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    }),
    openStream: () => new ReadStream(open()),
    write: (bytes) => {
      writeSync(open(), bytes);
    },
  });
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
