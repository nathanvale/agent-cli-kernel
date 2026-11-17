import { json, record } from "./primitives.ts";

const orderedArrays: ReadonlySet<string> = new Set();

function canonical(
  value: unknown,
  unordered: ReadonlySet<string>,
  key = "",
): string {
  if (Array.isArray(value)) {
    const entries: unknown[] = Array.from(value);
    const encoded = entries.map((entry) => canonical(entry, unordered));
    return `array:${JSON.stringify(unordered.has(key) ? encoded.sort() : encoded)}`;
  }
  if (record(value))
    return `object:${JSON.stringify(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, entry]) => [name, canonical(entry, unordered, name)]),
    )}`;
  return `scalar:${JSON.stringify(value) ?? ""}`;
}

export function sameJson(
  actual: unknown,
  expected: unknown,
  unordered: ReadonlySet<string> = orderedArrays,
): boolean {
  if (actual === undefined || expected === undefined)
    return actual === expected;
  return (
    json(actual) &&
    json(expected) &&
    canonical(actual, unordered) === canonical(expected, unordered)
  );
}
