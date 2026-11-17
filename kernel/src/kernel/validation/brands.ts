import type { AuthorityId, ParsedPath, ResourceId } from "../capabilities.ts";
import { text } from "./primitives.ts";
function identity(value: unknown): string {
  if (!text(value) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
    throw new Error("Invalid identity.");
  return value;
}
export function authority(value: unknown): AuthorityId {
  return identity(value) as AuthorityId;
}
export function resource(value: unknown): ResourceId {
  return identity(value) as ResourceId;
}
export function path(value: unknown): ParsedPath {
  const valid = identity(value);
  if (!valid.startsWith("/")) throw new Error("Expected absolute path.");
  return valid as ParsedPath;
}
