import { readFileSync } from "node:fs";
import { join } from "node:path";
import { treeFiles } from "../../support/lint-rule-folder.ts";

export const repository = join(import.meta.dir, "../../..");
export const packageName = "agent-cli-kernel";
const exampleFolder = join(import.meta.dir, "example");
const stored = ".txt";

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function exampleFiles(
  folder = exampleFolder,
): ReadonlyMap<string, string> {
  return new Map(
    treeFiles("**/*", folder)
      .map((path): [string, string] => {
        if (!path.endsWith(stored))
          throw new Error(
            `${path} is in the example folder without the ${stored} ending. Repair: store each example file as <path in a repository that depends on the kernel>${stored}.`,
          );
        return [
          path.slice(0, -stored.length),
          readFileSync(join(folder, path), "utf8"),
        ];
      })
      .sort(([a], [b]) => byCodeUnit(a, b)),
  );
}
