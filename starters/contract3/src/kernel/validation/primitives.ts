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
// A canonical array index below the array's length.
function arrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    String(index) === key &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < length
  );
}
// An array has exactly its index keys and its length, on Array.prototype.
function exactArray(value: object): boolean {
  if (!Array.isArray(value)) return true;
  const keys = Reflect.ownKeys(value);
  return (
    Object.getPrototypeOf(value) === Array.prototype &&
    keys.length === value.length + 1 &&
    keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" && arrayIndex(key, value.length)),
    )
  );
}
// Every own property is traversed, not only enumerable values: a hidden key
// or hidden toJSON would otherwise validate one shape and serialise another
// (F06, LIFE-7 step 2).
function ownJsonValues(value: object): unknown[] | undefined {
  if (!exactArray(value)) return undefined;
  const values: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor =
      typeof key === "string"
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined;
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    values.push(descriptor.value);
  }
  return values;
}
// Shared subgraphs are revisited per path, so a small value can describe
// exponential work (F17). One traversal visits at most this many JSON values,
// then refuses. ENGINEERING NUMBER, NO CONTRACT SOURCE: no clause sets a
// total-work bound; this one keeps a traversal near 50 ms (measured on the
// repair host) so the first signal can still end the run within LIFE-3.
// Revisit it if the contract binds a number.
const jsonValueBudget = 1_000_000;
export function json(
  value: unknown,
  depth = rootLevel,
  ancestors = new Set<object>(),
  budget = { remaining: jsonValueBudget },
): value is JsonValue {
  if (!withinLevel(depth, resultLevelLimit) || --budget.remaining < 0)
    return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && !record(value)) return false;
  const values = ownJsonValues(value);
  if (!values) return false;
  ancestors.add(value);
  const valid = values.every((child) =>
    json(child, childLevel(depth), ancestors, budget),
  );
  ancestors.delete(value);
  return valid;
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
