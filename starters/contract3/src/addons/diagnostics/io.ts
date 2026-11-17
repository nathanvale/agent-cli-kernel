import { closeSync, fstatSync, openSync, write } from "node:fs";

export type DiagnosticsIo = {
  readonly open: (path: string, flags: number, mode: number) => number;
  readonly write: (descriptor: number, bytes: Uint8Array) => Promise<number>;
  readonly size: (descriptor: number) => number;
  readonly close: (descriptor: number) => void;
};

export const nodeIo: DiagnosticsIo = {
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (descriptor, bytes) =>
    new Promise((resolve, reject) => {
      write(descriptor, bytes, 0, bytes.length, null, (error, written) => {
        if (error) reject(error);
        else resolve(written);
      });
    }),
  size: (descriptor) => fstatSync(descriptor).size,
  close: (descriptor) => {
    closeSync(descriptor);
  },
};

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
