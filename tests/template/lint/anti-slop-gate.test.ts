import { expect, test } from "bun:test";
import { messages } from "../../support/template-lint.ts";

const filePath = "scripts/doctor.ts";

const gate = [
  {
    name: "anti-slop/no-chained-type-assertions",
    ruleId: "no-restricted-syntax",
    refused: `export const value = Number("1") as unknown as string;
`,
    admitted: `export const value = ["a"] as const;
`,
  },
  {
    name: "anti-slop/no-widen-then-assert",
    ruleId: "anti-slop/no-widen-then-assert",
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
    name: "anti-slop/no-unknown-type-aliases",
    ruleId: "anti-slop/no-unknown-type-aliases",
    refused: `export type Opaque = unknown;
`,
    admitted: `export type Name = string;
`,
  },
  {
    name: "anti-slop/no-module-mocking",
    ruleId: "anti-slop/no-module-mocking",
    refused: `import { vi } from "vitest";

vi.mock("./dependency.ts");
`,
    admitted: `import { vi } from "vitest";

export const spy = vi.fn();
`,
  },
  {
    name: "anti-slop/no-reduce-accumulator-copy",
    ruleId: "anti-slop/no-reduce-accumulator-copy",
    refused: `export const copied = [1, 2].reduce((all, each) => all.concat([each]), []);
`,
    admitted: `export const total = [1, 2].reduce((sum, each) => sum + each, 0);
`,
  },
  {
    name: "oxc/no-accumulating-spread",
    ruleId: "anti-slop/no-accumulating-spread",
    refused: `export const spread = [1, 2].reduce((all, each) => [...all, each], []);
`,
    admitted: `export const merged = [...[1, 2], 3];
`,
  },
] as const;

const gateRules = new Set<string | null>([
  null,
  ...gate.map(({ ruleId }) => ruleId),
]);

async function gateHits(code: string) {
  return (await messages(filePath, code))
    .filter(({ ruleId }) => gateRules.has(ruleId))
    .map(({ ruleId }) => ruleId);
}

const verdicts = new Map<string, { refused: unknown[]; admitted: unknown[] }>();
for (const { name, refused, admitted } of gate)
  verdicts.set(name, {
    refused: await gateHits(refused),
    admitted: await gateHits(admitted),
  });

for (const { name, ruleId } of gate) {
  test(`${name} refuses its violation`, () => {
    expect(verdicts.get(name)?.refused).toEqual([ruleId]);
  });

  test(`${name} admits its clean form`, () => {
    expect(verdicts.get(name)?.admitted).toEqual([]);
  });
}
