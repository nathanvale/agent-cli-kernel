import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnBounded } from "./support/process.ts";
import { testFolder } from "./support/test-folder.ts";

const repository = join(import.meta.dir, "..");
const bound = 30_000;
const timeout = 40_000;

const gate = [
  {
    rule: "anti-slop/no-chained-type-assertions",
    refused: `export const value = Number("1") as unknown as string;
`,
    admitted: `export const value = ["a"] as const;
`,
  },
  {
    rule: "anti-slop/no-widen-then-assert",
    refused: `type Shape = { readonly name: string };
const known: Shape = { name: "a" };
const widened: unknown = known;
export const narrowed = widened as Shape;
`,
    admitted: `type Shape = { readonly name: string };
const known: Shape = { name: "a" };
export const same = known;
`,
  },
  {
    rule: "anti-slop/no-unknown-type-aliases",
    refused: `export type Opaque = unknown;
`,
    admitted: `export type Name = string;
`,
  },
  {
    rule: "anti-slop/no-module-mocking",
    refused: `import { vi } from "vitest";

vi.mock("./dependency.ts");
`,
    admitted: `import { vi } from "vitest";

export const spy = vi.fn();
`,
  },
  {
    rule: "anti-slop/no-reduce-accumulator-copy",
    refused: `export const copied = [1, 2].reduce((all, each) => all.concat([each]), []);
`,
    admitted: `export const total = [1, 2].reduce((sum, each) => sum + each, 0);
`,
  },
  {
    rule: "oxc/no-accumulating-spread",
    refused: `export const spread = [1, 2].reduce((all, each) => [...all, each], []);
`,
    admitted: `export const merged = [...[1, 2], 3];
`,
  },
] as const;

function fileFor(rule: string, verdict: "refused" | "admitted"): string {
  return `${rule.replace("/", "-")}.${verdict}.ts`;
}

function codeFor(rule: string): string {
  return rule.replace("/", "(").concat(")");
}

const folder = testFolder("anti-slop-gate-");
for (const { rule, refused, admitted } of gate) {
  writeFileSync(join(folder, fileFor(rule, "refused")), refused);
  writeFileSync(join(folder, fileFor(rule, "admitted")), admitted);
}

const run = await spawnBounded(
  [
    join(repository, "node_modules/.bin/oxlint"),
    "-c",
    join(repository, ".oxlintrc.json"),
    "--format",
    "json",
    ".",
  ],
  { cwd: folder, boundMilliseconds: bound },
);

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const report: unknown = JSON.parse(run.stdout);
const listed: unknown = Reflect.get(Object(report), "diagnostics");
const diagnostics: readonly unknown[] = Array.isArray(listed) ? listed : [];

function codesIn(file: string): string[] {
  return diagnostics
    .filter(
      (diagnostic) => Reflect.get(Object(diagnostic), "filename") === file,
    )
    .map((diagnostic) => String(Reflect.get(Object(diagnostic), "code")));
}

for (const { rule } of gate) {
  test(
    `${rule} refuses its violation`,
    () => {
      expect(codesIn(fileFor(rule, "refused"))).toEqual([codeFor(rule)]);
    },
    timeout,
  );

  test(
    `${rule} admits its clean form`,
    () => {
      expect(codesIn(fileFor(rule, "admitted"))).toEqual([]);
    },
    timeout,
  );
}
