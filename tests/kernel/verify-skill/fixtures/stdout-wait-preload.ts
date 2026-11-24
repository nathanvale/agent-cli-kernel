import { writeSync } from "node:fs";

type Written = (error?: Error | null) => void;

const waitSignalFd = 3;
const stdout = process.stdout;
const writeStdout = stdout.write.bind(stdout);
let waitSignalled = false;

function signalOnTurnAfterFirstWrite(): void {
  if (waitSignalled) return;
  waitSignalled = true;
  setImmediate(() => writeSync(waitSignalFd, "waiting\n"));
}

function signallingWrite(chunk: string | Uint8Array, done?: Written): boolean;
function signallingWrite(
  chunk: string | Uint8Array,
  encoding?: BufferEncoding,
  done?: Written,
): boolean;
function signallingWrite(
  chunk: string | Uint8Array,
  encodingOrDone?: BufferEncoding | Written,
  done?: Written,
): boolean {
  signalOnTurnAfterFirstWrite();
  return typeof encodingOrDone === "function"
    ? writeStdout(chunk, encodingOrDone)
    : writeStdout(chunk, encodingOrDone, done);
}

stdout.write = signallingWrite;
