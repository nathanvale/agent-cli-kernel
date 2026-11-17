import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { doctor } from "./doctor.ts";

// Platform: bun test reads a path without a ./ prefix as a substring filter, so
// "tests/contract3/state" would also run state-seam.test.ts.
const contract3 = "tests/contract3";

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

function testFiles(root: string, directory: string): string[] {
  return entries(join(root, directory))
    .filter((entry) => entry.isFile() && isTest(entry.name))
    .map((entry) => `./${directory}/${entry.name}`);
}

function areas(root: string): Map<string, string[]> {
  const candidates: [string, string[]][] = [
    ["template", testFiles(root, "tests")],
    ["kernel", testFiles(root, contract3)],
    [
      "glossary",
      holdsTests(join(root, "tests/glossary")) ? ["./tests/glossary"] : [],
    ],
    [
      "standards",
      holdsTests(join(root, "tests/standards")) ? ["./tests/standards"] : [],
    ],
    ...entries(join(root, contract3))
      .filter(
        (entry) =>
          entry.isDirectory() && holdsTests(join(root, contract3, entry.name)),
      )
      .map((entry): [string, string[]] => [
        entry.name,
        [`./${contract3}/${entry.name}`],
      ]),
  ];
  return new Map(candidates.filter(([, paths]) => paths.length > 0));
}

const root = join(import.meta.dir, "..");
const known = areas(root);
const [area, ...options] = process.argv.slice(2);
const paths = area === undefined ? undefined : known.get(area);

if (paths === undefined) {
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
