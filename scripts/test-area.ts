import { readdirSync } from "node:fs";
import { join } from "node:path";
import { doctor } from "./doctor.ts";

// bun test reads a path without a ./ prefix as a substring filter, so
// "tests/contract3/state" would also run state-seam.test.ts.
const contract3 = "tests/contract3";

function isTest(name: string): boolean {
  return name.endsWith(".test.ts");
}

function holdsTests(directory: string): boolean {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).some(
    isTest,
  );
}

function areas(root: string): Map<string, string[]> {
  const entries = readdirSync(join(root, contract3), { withFileTypes: true });
  const found = new Map<string, string[]>([
    [
      "kernel",
      entries
        .filter((entry) => entry.isFile() && isTest(entry.name))
        .map((entry) => `./${contract3}/${entry.name}`),
    ],
    ["glossary", ["./tests/glossary"]],
  ]);
  for (const entry of entries)
    if (entry.isDirectory() && holdsTests(join(root, contract3, entry.name)))
      found.set(entry.name, [`./${contract3}/${entry.name}`]);
  return found;
}

const root = process.cwd();
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
