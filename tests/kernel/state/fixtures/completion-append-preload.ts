import { mock } from "bun:test";
import * as fs from "node:fs";

const orig: typeof fs = { ...fs };
const fault = /^(completion|not-applied|outcome)-(write|flush)-fails$/.exec(
  process.env.SX_APPEND_FAULT ?? "",
);
const frameHeader = new TextEncoder().encode(`C3S1 ${fault?.[1] ?? ""} `);
const flushPending = new Set<number>();

function isFaultedFrame(buffer: unknown): boolean {
  return (
    fault !== null &&
    buffer instanceof Uint8Array &&
    frameHeader.every((byte, index) => buffer[index] === byte)
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
  if (isFaultedFrame(buffer)) {
    if (fault?.[2] === "write") throw plantedIoError("write");
    flushPending.add(descriptor);
  }
  return Reflect.apply(orig.writeSync, orig, args);
}

function fsyncSync(descriptor: number): void {
  if (flushPending.delete(descriptor)) throw plantedIoError("fsync");
  orig.fsyncSync(descriptor);
}

void mock.module("node:fs", () => ({ ...orig, writeSync, fsyncSync }));
