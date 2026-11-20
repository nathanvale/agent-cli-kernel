import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { lintRuleFolder } from "../support/lint-rule-folder.ts";
import { reviewSpecimens } from "./locks/review-specimens.ts";

const root = resolve(import.meta.dir, "../..");
let probes: string;
let stateProbes: string;
let handlerProbes: string;
const eslint = new ESLint({ cwd: root });
beforeAll(async () => {
  probes = lintRuleFolder(resolve(root, "tests/kernel"));
  handlerProbes = lintRuleFolder(resolve(root, "kernel/src/handlers"));
  stateProbes = lintRuleFolder(resolve(root, "kernel/src/addons/state"));
  for (const extension of ["ts", "mts", "cts"]) {
    await writeFile(`${handlerProbes}/control.${extension}`, "export {};\n");
    await writeFile(`${probes}/control.${extension}`, "export {};\n");
  }
  await writeFile(`${stateProbes}/control.ts`, "export {};\n");
});
afterAll(async () => {
  await rm(probes, { recursive: true, force: true });
  await rm(stateProbes, { recursive: true, force: true });
  await rm(handlerProbes, { recursive: true, force: true });
});

async function findings(source: string, filePath: string) {
  const results = await eslint.lintText(source, { filePath });
  expect(results).toHaveLength(1);
  return results.flatMap((result) => result.messages);
}

for (const extension of ["ts", "mts", "cts"]) {
  test(`final config rejects casts and expected-error markers in ${extension} tests`, async () => {
    const file = `${probes}/control.${extension}`;
    expect(
      (await findings('export const value = "x" as string;', file)).map(
        (m) => m.ruleId,
      ),
    ).toContain("@typescript-eslint/consistent-type-assertions");
    expect(
      (
        await findings(
          "// @ts-expect-error: forbidden outside locks\nexport const value = 1;",
          file,
        )
      ).map((m) => m.ruleId),
    ).toContain("@typescript-eslint/ban-ts-comment");
  });
  test(`final config retains const, satisfies and genuine generics in ${extension}`, async () => {
    const file = `${probes}/control.${extension}`;
    expect(
      await findings(
        'export const value = { name: "x" } as const satisfies { readonly name: string }; export function identity<T>(value: T): T { return value; }',
        file,
      ),
    ).toEqual([]);
  });
}

test("selected contract rules reject each bypass through the final config", async () => {
  const file = `${probes}/control.ts`;
  const controls = [
    [
      "export function forged(value: unknown): value is string { return Boolean(value); }",
      "no-restricted-syntax",
    ],
    [
      "export const value = Object.assign({}, { exitCode: 42 });",
      "no-restricted-syntax",
    ],
    [
      "const target = { exitCode: 0 }; Object.assign(target, { exitCode: 42 }); export { target };",
      "no-restricted-syntax",
    ],
    [
      'export const value = Object["assign"]({}, { exitCode: 42 });',
      "no-restricted-syntax",
    ],
    [
      "export function unused<T>(value: string): string { return value; }",
      "@typescript-eslint/no-unnecessary-type-parameters",
    ],
    [
      'export function choose(value: "success" | "refused") { switch(value) { case "success": return 0; default: return 1; } }',
      "@typescript-eslint/switch-exhaustiveness-check",
    ],
    [
      '// eslint-disable-next-line @typescript-eslint/consistent-type-assertions\nexport const value = "x" as string;',
      "@typescript-eslint/consistent-type-assertions",
    ],
    [
      'export const value = "x" as unknown as number;',
      "@typescript-eslint/consistent-type-assertions",
    ],
  ] as const;
  expect(controls).toHaveLength(8);
  for (const [source, rule] of controls)
    expect((await findings(source, file)).map((m) => m.ruleId)).toContain(rule);
});

test("rooted validation exception permits named brands but rejects whole-result casts", async () => {
  const file = resolve(root, "kernel/src/kernel/validation/brands.ts");
  expect(
    await findings(
      'import type { AuthorityId } from "../capabilities.ts"; export function brand(value: string) { return value as AuthorityId; }',
      file,
    ),
  ).toEqual([]);
  expect(
    (
      await findings(
        'import type { WireResult } from "../types.ts"; export function forge(value: unknown) { return value as WireResult; }',
        file,
      )
    ).map((m) => m.ruleId),
  ).toContain("no-restricted-syntax");
  const outside = `${probes}/control.ts`;
  expect(
    (
      await findings(
        "type AuthorityId = string; export function forge(value: unknown) { return value as AuthorityId; }",
        outside,
      )
    ).map((m) => m.ruleId),
  ).toContain("@typescript-eslint/consistent-type-assertions");
});

test("production files receive the same policy and source cannot import tests", async () => {
  const file = resolve(root, "kernel/src/kernel/types.ts");
  expect(
    (await findings('export const value = "x" as string;', file)).map(
      (m) => m.ruleId,
    ),
  ).toContain("@typescript-eslint/consistent-type-assertions");
  expect(
    (
      await findings(
        "// @ts-expect-error: forbidden in production\nexport const value = 1;",
        file,
      )
    ).map((m) => m.ruleId),
  ).toContain("@typescript-eslint/ban-ts-comment");
  expect(
    (
      await findings(
        'import "../../../../tests/kernel/contract.test.ts";',
        file,
      )
    ).map((m) => m.ruleId),
  ).toContain("no-restricted-imports");
});

test("validation rejects angle-bracket whole-result assertions", async () => {
  const file = resolve(root, "kernel/src/kernel/validation/brands.ts");
  expect(
    (
      await findings(
        'import type { WireResult } from "../types.ts"; export function forge(value: unknown) { return <WireResult>value; }',
        file,
      )
    ).map((m) => m.ruleId),
  ).toContain("no-restricted-syntax");
});

test("effective config covers every rooted contract role and extension", async () => {
  const roles = ["kernel", "builders", "adapters", "handlers", "consumers"];
  expect(roles).toHaveLength(5);
  for (const role of roles) {
    for (const extension of ["ts", "mts", "cts"]) {
      const config: unknown = await eslint.calculateConfigForFile(
        `kernel/src/${role}/coverage.${extension}`,
      );
      expect(config).toMatchObject({
        linterOptions: { noInlineConfig: true },
        rules: {
          "@typescript-eslint/consistent-type-assertions": [
            2,
            { assertionStyle: "never" },
          ],
          "@typescript-eslint/no-unnecessary-type-parameters": [2],
          "@typescript-eslint/switch-exhaustiveness-check": [
            2,
            { considerDefaultExhaustiveForUnions: false },
          ],
          "@typescript-eslint/ban-ts-comment": [
            2,
            {
              "ts-expect-error": true,
              "ts-ignore": true,
              "ts-nocheck": true,
              "ts-check": false,
            },
          ],
        },
      });
    }
  }
  const lockConfig: unknown = await eslint.calculateConfigForFile(
    "tests/kernel/locks/control.ts",
  );
  expect(lockConfig).toMatchObject({
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        2,
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
        },
      ],
    },
  });
});

test("review-owned specimens expose lint limits without claiming soundness", async () => {
  expect(reviewSpecimens.map((item) => String(item.id))).toEqual([
    "conversion-overload",
    "partial-record",
    "map-fallback",
    "ternary-fallback",
    "in-check",
    "if-without-never",
    "assign-alias",
  ]);
  for (const specimen of reviewSpecimens) {
    expect(specimen.finding.length).toBeGreaterThan(0);
    expect(await findings(specimen.source, `${probes}/control.ts`)).toEqual([]);
  }
});

test("host cannot take or alias the state add-on factory property", async () => {
  const file = `${probes}/control.ts`;
  const prefix = "declare const kernel: { stateAddon: () => void }; ";
  for (const source of [
    "export const factory = kernel.stateAddon;",
    'export const factory = kernel["stateAddon"];',
    "const { stateAddon: factory } = kernel; export { factory };",
    "const alias = kernel; export const factory = alias.stateAddon;",
  ]) {
    expect(
      (await findings(prefix + source, file)).map((message) => message.ruleId),
    ).toContain("no-restricted-properties");
  }
});

test("canonical state source can reference the state add-on factory", async () => {
  expect(
    await findings(
      "declare const kernel: { stateAddon: () => void }; export const factory = kernel.stateAddon;",
      `${stateProbes}/control.ts`,
    ),
  ).toEqual([]);
});

test("add-on source imports kernel only through the public index", async () => {
  const file = `${stateProbes}/control.ts`;
  for (const source of [
    'import { commonCauses } from "../../../kernel/causes.ts"; export { commonCauses };',
    'import type { StateIssuer } from "../../../kernel/capabilities.ts"; export type { StateIssuer };',
  ]) {
    expect(
      (await findings(source, file)).map((message) => message.ruleId),
    ).toContain("no-restricted-imports");
  }
  expect(
    await findings(
      'import { commonCauses } from "../../../kernel/index.ts"; export { commonCauses };',
      file,
    ),
  ).toEqual([]);
});

test("kernel index allows only the exact state add-on factory declaration", async () => {
  const file = resolve(root, "kernel/src/kernel/index.ts");
  const prefix =
    "declare function contractFor(): void; declare function createStateAddon(): void; ";
  expect(
    await findings(prefix + "contractFor.stateAddon = createStateAddon;", file),
  ).toEqual([]);
  for (const source of [
    "export const factory = contractFor.stateAddon;",
    'export const factory = contractFor["stateAddon"];',
    "const { stateAddon: factory } = contractFor; export { factory };",
    "const alias = contractFor; export const factory = alias.stateAddon;",
  ]) {
    expect(
      (await findings(prefix + source, file)).map((message) => message.ruleId),
    ).toContain("no-restricted-syntax");
  }
});

test("dynamic add-on imports use only the kernel public index", async () => {
  const file = `${stateProbes}/control.ts`;
  expect(
    (
      await findings(
        'export const kernel = await import("../../../kernel/state-seam.ts");',
        file,
      )
    ).map((message) => message.ruleId),
  ).toContain("no-restricted-syntax");
  expect(
    await findings(
      'export const kernel = await import("../../../kernel/index.ts");',
      file,
    ),
  ).toEqual([]);
});

for (const extension of ["ts", "mts", "cts"]) {
  for (const role of ["tests", "handlers"]) {
    test(`Object.assign construction and mutation fail in ${role} ${extension}`, async () => {
      const file = `${role === "tests" ? probes : handlerProbes}/control.${extension}`;
      for (const source of [
        "export const value = Object.assign({}, { exitCode: 42 });",
        "const value = { exitCode: 0 }; Object.assign(value, { exitCode: 42 }); export { value };",
      ]) {
        expect(
          (await findings(source, file)).map((message) => message.ruleId),
        ).toContain("no-restricted-syntax");
      }
      expect(
        await findings("export const value = { ...{ exitCode: 0 } };", file),
      ).toEqual([]);
      expect(
        await findings(
          "const value = { exitCode: 0 }; value.exitCode = 3; export { value };",
          file,
        ),
      ).toEqual([]);
    });
  }
}
