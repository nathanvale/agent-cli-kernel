import { readFileSync } from "node:fs";

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

export function jsonFile(path: string): unknown {
  try {
    return parsedJson(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? Array.from(value, (item: unknown) => item) : [];
}
