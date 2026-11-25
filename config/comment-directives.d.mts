import type { SourceCode } from "eslint";

export function loadBiomeCategories(schemaPath?: string): ReadonlySet<string>;
export function isDirectiveBlock(
  block: readonly unknown[],
  source?: SourceCode,
): boolean;
