import type { JsonValue } from "../types.ts";
import {
  childLevel,
  resultLevelLimit,
  rootLevel,
  withinLevel,
} from "./level.ts";
export function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}
function arrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    String(index) === key &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < length
  );
}
export type JsonCopy =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false };
const invalidJson: JsonCopy = { ok: false };
const jsonValueBudget = 1_000_000;
function copyOwnValue(
  value: object,
  key: string,
  depth: number,
  ancestors: Set<object>,
  budget: { remaining: number },
): JsonCopy {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
    return invalidJson;
  return copyJson(descriptor.value, childLevel(depth), ancestors, budget);
}
function arrayLength(value: readonly unknown[]): number | undefined {
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  return descriptor &&
    Object.hasOwn(descriptor, "value") &&
    integer(descriptor.value)
    ? descriptor.value
    : undefined;
}
function copyArray(
  value: readonly unknown[],
  depth: number,
  ancestors: Set<object>,
  budget: { remaining: number },
): JsonCopy {
  const length = arrayLength(value);
  if (length === undefined) return invalidJson;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) return invalidJson;
  const copy: JsonValue[] = [];
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !arrayIndex(key, length)) return invalidJson;
    const child = copyOwnValue(value, key, depth, ancestors, budget);
    if (!child.ok) return invalidJson;
    copy[Number(key)] = child.value;
  }
  return { ok: true, value: copy };
}
function copyRecord(
  value: object,
  depth: number,
  ancestors: Set<object>,
  budget: { remaining: number },
): JsonCopy {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidJson;
  const copy: Record<string, JsonValue> = {};
  if (prototype === null) Object.setPrototypeOf(copy, null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return invalidJson;
    const child = copyOwnValue(value, key, depth, ancestors, budget);
    if (!child.ok) return invalidJson;
    Object.defineProperty(copy, key, {
      value: child.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, value: copy };
}
export function copyJson(
  value: unknown,
  depth = rootLevel,
  ancestors = new Set<object>(),
  budget = { remaining: jsonValueBudget },
): JsonCopy {
  if (!withinLevel(depth, resultLevelLimit) || --budget.remaining < 0)
    return invalidJson;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return { ok: true, value };
  if (typeof value === "number")
    return Number.isFinite(value) ? { ok: true, value } : invalidJson;
  if (typeof value !== "object" || ancestors.has(value)) return invalidJson;
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? copyArray(value, depth, ancestors, budget)
      : copyRecord(value, depth, ancestors, budget);
  } finally {
    ancestors.delete(value);
  }
}
export function json(
  value: unknown,
  depth = rootLevel,
  ancestors = new Set<object>(),
  budget = { remaining: jsonValueBudget },
): value is JsonValue {
  return copyJson(value, depth, ancestors, budget).ok;
}
export function sortedStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown, index: number) =>
        text(entry) &&
        (index === 0 ||
          (typeof value[index - 1] === "string" && value[index - 1] < entry)),
    )
  );
}
