import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
