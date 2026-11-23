import { mock } from "bun:test";
import * as fs from "node:fs";

const orig: typeof fs = { ...fs };
const fault = process.env.SX_FAULT ?? "";
const completionHeader = new TextEncoder().encode("C3S1 completion ");
const flushPending = new Set<number>();

function isCompletionFrame(buffer: unknown): boolean {
  return (
    buffer instanceof Uint8Array &&
    completionHeader.every((byte, index) => buffer[index] === byte)
  );
}

class PlantedIoError extends Error {
  readonly code = "EIO";
}

function plantedIoError(call: string): Error {
  return new PlantedIoError(`EIO: planted ${call} failure`);
}

function writeSync(...args: Parameters<typeof fs.writeSync>): number {
  const [descriptor, buffer] = args;
  if (isCompletionFrame(buffer)) {
    if (fault === "completion-write-fails") throw plantedIoError("write");
    if (fault === "completion-flush-fails") flushPending.add(descriptor);
  }
  return Reflect.apply(orig.writeSync, orig, args);
}

function fsyncSync(descriptor: number): void {
  if (flushPending.delete(descriptor)) throw plantedIoError("fsync");
  orig.fsyncSync(descriptor);
}

void mock.module("node:fs", () => ({ ...orig, writeSync, fsyncSync }));
