import { type Dirent, readdirSync, readFileSync } from "node:fs";

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!Object.hasOwn(error, "code")) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export function isAbsentError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isMissingDirectoryError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export function readOptionalUtf8(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isAbsentError(error)) return undefined;
    throw error;
  }
}

export function readOptionalDirectory(path: string): Dirent[] | undefined {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) return undefined;
    throw error;
  }
}
