import { readRootedFile } from "../../shared/rooted-file.ts";
import { ApprovalRejection } from "./rejection.ts";

export type RecordFacts = {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
};

const limitBytes = 16 * 1024;
const depthLimit = 8;

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export function readUntrusted(
  root: string,
  path: string,
): { readonly value: unknown; readonly facts: RecordFacts } | undefined {
  let result;
  try {
    result = readRootedFile(root, path, limitBytes);
  } catch (error) {
    throw new ApprovalRejection("store-unavailable", error);
  }
  if (result.kind !== "read") return undefined;
  const value = decode(result.bytes);
  if (!value) return undefined;
  const { uid, gid, mode, dev, ino } = result.facts;
  return { value: value.parsed, facts: { path, uid, gid, mode, dev, ino } };
}

function decode(bytes: Uint8Array): { readonly parsed: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
  return withinDepth(parsed, 0) ? { parsed } : undefined;
}

function withinDepth(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (depth >= depthLimit) return false;
  const items: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return items.every((item) => withinDepth(item, depth + 1));
}
