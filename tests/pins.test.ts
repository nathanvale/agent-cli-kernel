import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const workflows = ".github/workflows";

function bunVersions(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(bunVersions);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]: [string, unknown]) =>
    key === "bun-version" ? [value] : bunVersions(value),
  );
}

test("every bun-version in a workflow equals the packageManager pin", async () => {
  const { packageManager } = (await Bun.file(
    join(root, "package.json"),
  ).json()) as { packageManager: string };
  const declared: { file: string; pin: string }[] = [];
  for (const name of readdirSync(join(root, workflows)).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = `${workflows}/${name}`;
    const workflow = Bun.YAML.parse(await Bun.file(join(root, file)).text());
    for (const version of bunVersions(workflow))
      declared.push({ file, pin: `bun@${String(version)}` });
  }

  expect(declared.length).toBeGreaterThan(0);
  expect(
    declared
      .filter(({ pin }) => pin !== packageManager)
      .map(
        ({ file, pin }) =>
          `${file} sets ${pin}, package.json pins ${packageManager}`,
      ),
  ).toEqual([]);
});
