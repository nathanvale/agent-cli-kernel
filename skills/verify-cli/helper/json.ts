import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function at(value: unknown, ...names: readonly string[]): unknown {
  return names.reduce<unknown>(
    (current, name) =>
      typeof current === "object" &&
      current !== null &&
      Object.hasOwn(current, name)
        ? Reflect.get(current, name)
        : undefined,
    value,
  );
}

export function parsedJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

export const evidenceBytesLimit = 134_217_728;

export type FileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "read"; readonly bytes: Buffer }
  | { readonly kind: "unreadable"; readonly reason: string };

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOpened(descriptor: number, path: string, limit: number): FileRead {
  const stats = fstatSync(descriptor);
  if (!stats.isFile())
    return { kind: "unreadable", reason: `${path} is not a regular file` };
  if (stats.size > limit)
    return {
      kind: "unreadable",
      reason: `${path} is ${String(stats.size)} bytes, over ${String(limit)}`,
    };
  const bytes = Buffer.alloc(stats.size);
  let filled = 0;
  while (filled < bytes.byteLength) {
    const read = readSync(
      descriptor,
      bytes,
      filled,
      bytes.byteLength - filled,
      filled,
    );
    if (read === 0) break;
    filled += read;
  }
  return { kind: "read", bytes: bytes.subarray(0, filled) };
}

export function readRegularFile(path: string, limit: number): FileRead {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: failureReason(error) };
  }
  try {
    return readOpened(descriptor, path, limit);
  } catch (error) {
    return { kind: "unreadable", reason: failureReason(error) };
  } finally {
    closeSync(descriptor);
  }
}

export type JsonRead =
  | { readonly kind: "missing" }
  | { readonly kind: "read"; readonly value: unknown }
  | { readonly kind: "unreadable"; readonly reason: string };

function errorCode(error: unknown): unknown {
  return at(error, "code");
}

export function readJsonFile(
  path: string,
  limit = evidenceBytesLimit,
): JsonRead {
  const file = readRegularFile(path, limit);
  if (file.kind !== "read") return file;
  const text = file.bytes.toString("utf8");
  try {
    const value: unknown = JSON.parse(text);
    return { kind: "read", value };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? Array.from(value, (item: unknown) => item) : [];
}
