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

export type JsonRead =
  | { readonly kind: "missing" }
  | { readonly kind: "read"; readonly value: unknown }
  | { readonly kind: "unreadable"; readonly reason: string };

function errorCode(error: unknown): unknown {
  return at(error, "code");
}

export function readJsonFile(path: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
