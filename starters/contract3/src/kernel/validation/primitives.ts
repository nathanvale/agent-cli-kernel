import type { JsonValue } from "../types.ts";
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
export function json(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && !record(value)) return false;
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => descriptor.get || descriptor.set,
    )
  )
    return false;
  ancestors.add(value);
  const values: unknown[] = Array.isArray(value)
    ? Array.from(value)
    : Object.values(value);
  const valid = values.every((child) => json(child, depth + 1, ancestors));
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
