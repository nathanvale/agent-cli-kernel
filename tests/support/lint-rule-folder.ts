import { globSync, mkdirSync } from "node:fs";
import { testFolder } from "./test-folder.ts";

const prefix = "lint-rule-folder-";

export function lintRuleFolder(parent: string): string {
  mkdirSync(parent, { recursive: true });
  return testFolder(prefix, parent);
}

export function treeFiles(pattern: string, cwd: string): string[] {
  return globSync(pattern, { cwd, exclude: [`**/${prefix}*`] });
}
