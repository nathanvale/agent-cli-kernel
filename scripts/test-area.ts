import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { doctor } from "./doctor.ts";
import { readRepository, type TestArea } from "./repository.ts";

function isTest(name: string): boolean {
  return name.endsWith(".test.ts");
}

function holdsTests(directory: string): boolean {
  return (
    existsSync(directory) &&
    readdirSync(directory, { recursive: true, encoding: "utf8" }).some(isTest)
  );
}

function entries(directory: string): Dirent[] {
  return existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
    : [];
}

// Platform: bun test reads a path without a ./ prefix as a substring filter, so
// "tests/contract3/state" would also run state-seam.test.ts.
function testFiles(root: string, directory: string): string[] {
  return entries(join(root, directory))
    .filter((entry) => entry.isFile() && isTest(entry.name))
    .map((entry) => `./${directory}/${entry.name}`);
}

function pathsOf(root: string, { holds, folder }: TestArea): string[] {
  if (holds === "files") return testFiles(root, folder);
  return holdsTests(join(root, folder)) ? [`./${folder}`] : [];
}

function subfolderAreas(
  root: string,
  { folder }: TestArea,
): [string, string[]][] {
  return entries(join(root, folder))
    .filter(
      (entry) =>
        entry.isDirectory() && holdsTests(join(root, folder, entry.name)),
    )
    .map((entry) => [entry.name, [`./${folder}/${entry.name}`]]);
}

function areas(root: string): {
  known: Map<string, string[]>;
  empty: string[];
} {
  const declared = readRepository(root).testAreas;
  const candidates = declared.flatMap((area): [string, string[]][] => [
    [area.name, pathsOf(root, area)],
    ...(area.subfolders ? subfolderAreas(root, area) : []),
  ]);
  return {
    known: new Map(candidates.filter(([, paths]) => paths.length > 0)),
    empty: declared
      .filter((area) => pathsOf(root, area).length === 0)
      .map(({ name, folder }) => `${name} (${folder})`),
  };
}

const root = join(import.meta.dir, "..");
const { known, empty } = areas(root);
const [area, ...options] = process.argv.slice(2);
const paths = area === undefined ? undefined : known.get(area);

if (empty.length > 0) {
  process.stderr.write(
    `repository.json declares test areas that hold no test file: ${empty.join(", ")}. Restore their tests, or remove them from testAreas.\n`,
  );
  process.exitCode = 1;
} else if (paths === undefined) {
  const valid = [...known.keys()].sort().join(", ");
  process.stderr.write(
    `Usage: bun run test:area <area> [bun test options]. ${area === undefined ? "No area given" : `Unknown area "${area}"`}. Valid areas: ${valid}.\n`,
  );
  process.exitCode = 2;
} else if (!(await doctor(root))) {
  process.exitCode = 1;
} else {
  const run = Bun.spawn([process.execPath, "test", ...paths, ...options], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exitCode = await run.exited;
}
