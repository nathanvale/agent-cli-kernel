import { afterAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { cleanTrees, get, run, tree } from "./harness.ts";
import { machine } from "./support.ts";

afterAll(cleanTrees);

test("KF6.a human-line-available file: the line names the run's private log", async () => {
  const where = tree();
  const human = await run({ argv: ["read"], tree: where });
  expect({ exit: human.exit, stderr: human.stderr }).toEqual({
    exit: 0,
    stderr: "",
  });
  const lines = human.stdout.split("\n");
  const last = lines.at(-2) ?? "";
  expect(last.startsWith("Diagnostics: ")).toBe(true);
  const file = last.slice("Diagnostics: ".length);
  expect(file.startsWith(`${where.dir}/`)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(lines.slice(0, -2).join("\n")).not.toContain("Diagnostics:");
  const twin = await run({ argv: ["read", ...machine], tree: tree() });
  expect(twin.exit).toBe(0);
  expect(twin.stdout).not.toContain("Diagnostics:");
  expect(get(twin.envelope, "diagnostics", "status")).toBe("available");
}, 60_000);
