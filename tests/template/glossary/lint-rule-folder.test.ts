import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { lintRuleFolder, treeFiles } from "../../support/lint-rule-folder.ts";

const folder = ownedFolders();

test("the glossary scan skips a lint rule folder, so a probe file deleted mid-scan is never read", () => {
  const tree = folder("glossary-tree-");
  const source = join(tree, "kernel/src");
  const probes = lintRuleFolder(source);
  writeFileSync(join(source, "kept.ts"), "export {};\n");
  writeFileSync(join(probes, "control.ts"), "export {};\n");
  expect(treeFiles("kernel/src/**/*.ts", tree)).toEqual(["kernel/src/kept.ts"]);
});
