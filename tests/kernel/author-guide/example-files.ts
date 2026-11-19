import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const repository = join(import.meta.dir, "../../..");
const exampleFolder = join(import.meta.dir, "example");
const stored = ".txt";

export const byCodeUnit = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export function exampleFiles(): ReadonlyMap<string, string> {
  return new Map(
    filesUnder(exampleFolder)
      .map((path): [string, string] => {
        if (!path.endsWith(stored))
          throw new Error(
            `${relative(repository, path)} is in the example folder without the ${stored} ending. Repair: store each example file as <path in a generated repository>${stored}.`,
          );
        return [
          relative(exampleFolder, path).slice(0, -stored.length),
          readFileSync(path, "utf8"),
        ];
      })
      .sort(([a], [b]) => byCodeUnit(a, b)),
  );
}
