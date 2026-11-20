import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { ownedFolders } from "../support/fixture-files.ts";

const repository = join(import.meta.dir, "../..");

function addOnImports(root: string): readonly string[] {
  const kernel = join(root, "kernel/src/kernel");
  const addons = join(root, "kernel/src/addons");
  const files = [...new Bun.Glob("**/*.{ts,mts,cts}").scanSync(kernel)].sort();
  return files.flatMap((file) => {
    const path = join(kernel, file);
    const source = readFileSync(path, "utf8");
    return ts
      .preProcessFile(source, true, true)
      .importedFiles.flatMap(({ fileName }) => {
        const intoAddOn = fileName.startsWith(".")
          ? `${resolve(dirname(path), fileName)}/`.startsWith(`${addons}/`)
          : /^agent-cli-kernel\/addons(?:\/|$)/.test(fileName);
        return intoAddOn
          ? [`kernel/src/kernel/${file} imports ${fileName}`]
          : [];
      });
  });
}

const folder = ownedFolders();

test("no file under kernel/src/kernel imports an add-on, by relative path or by the add-on exports", () => {
  expect(addOnImports(repository)).toEqual([]);
});

test("the add-on import scan finds a value import, a type import, a re-export, a dynamic import and an add-on export, and passes a kernel import", () => {
  const root = folder("add-on-boundary-");
  mkdirSync(join(root, "kernel/src/kernel"), { recursive: true });
  mkdirSync(join(root, "kernel/src/addons/state"), { recursive: true });
  writeFileSync(join(root, "kernel/src/addons/state/index.ts"), "export {};\n");
  writeFileSync(
    join(root, "kernel/src/kernel/probe.ts"),
    [
      'import { stateAddon } from "../addons/state/index.ts";',
      'import type { StateAddon } from "../addons/state/index.ts";',
      'export { stateAddon as again } from "../addons/state/index.ts";',
      'const later = import("../addons/state/index.ts");',
      'import { programsAddon } from "agent-cli-kernel/addons/programs";',
      'import { runProcess } from "./runtime.ts";',
      "",
    ].join("\n"),
  );
  expect([...addOnImports(root)].sort()).toEqual([
    "kernel/src/kernel/probe.ts imports ../addons/state/index.ts",
    "kernel/src/kernel/probe.ts imports ../addons/state/index.ts",
    "kernel/src/kernel/probe.ts imports ../addons/state/index.ts",
    "kernel/src/kernel/probe.ts imports ../addons/state/index.ts",
    "kernel/src/kernel/probe.ts imports agent-cli-kernel/addons/programs",
  ]);
});
