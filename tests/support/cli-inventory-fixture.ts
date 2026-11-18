import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Tree = Record<string, string>;

export function grown(root: string, tree: Tree): Set<string> {
  const paths = new Set<string>();
  for (const [name, text] of Object.entries(tree)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    paths.add(path);
  }
  return paths;
}
