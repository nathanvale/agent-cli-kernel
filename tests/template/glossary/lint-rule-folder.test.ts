import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { lintRuleFolder, treeFiles } from "../../support/lint-rule-folder.ts";

const folder = ownedFolders();

test("the glossary scan lists no file inside a lint rule folder", () => {
  const tree = folder("glossary-tree-");
  const source = join(tree, "kernel/src");
  const probes = lintRuleFolder(source);
  writeFileSync(join(source, "kept.ts"), "export {};\n");
  writeFileSync(join(probes, "control.ts"), "export {};\n");
  expect(treeFiles("kernel/src/**/*.ts", tree)).toEqual(["kernel/src/kept.ts"]);
});

test("the glossary scan lists files, not folders, so a pattern that names only a folder still counts as naming nothing", () => {
  const tree = folder("glossary-tree-");
  mkdirSync(join(tree, "kernel/src/addons"), { recursive: true });
  expect(treeFiles("kernel/src/**", tree)).toEqual([]);
});

test("the glossary scan still lists a file whose name starts like a lint rule folder", () => {
  const tree = folder("glossary-tree-");
  const source = join(tree, "kernel/src");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "lint-rule-folder-words.ts"), "export {};\n");
  expect(treeFiles("kernel/src/**/*.ts", tree)).toEqual([
    "kernel/src/lint-rule-folder-words.ts",
  ]);
});
