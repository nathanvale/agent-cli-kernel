import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { runFamily } from "./harness.ts";

// R11 (F09): the generated lint configuration bans starting programs outside
// the programs add-on (CMD-14), including through a dynamic import.
const root = resolve(import.meta.dir, "../../..");
const eslint = new ESLint({ cwd: root });
let hostFile = "";
let hostDirectory = "";
beforeAll(async () => {
  const parent = resolve(root, "starters/contract3/src/handlers");
  await mkdir(parent, { recursive: true });
  hostDirectory = await mkdtemp(`${parent}/repair-lint-`);
  hostFile = `${hostDirectory}/control.ts`;
  await writeFile(hostFile, "export {};\n");
});
afterAll(async () => {
  await rm(hostDirectory, { recursive: true, force: true });
});
const kernelFiles = [
  "starters/contract3/src/kernel/types.ts",
  "starters/contract3/src/kernel/index.ts",
  "starters/contract3/src/kernel/validation/brands.ts",
].map((file) => resolve(root, file));

async function errors(source: string, filePath: string) {
  const results = await eslint.lintText(source, { filePath });
  expect(results).toHaveLength(1);
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId);
}
const dynamic = (specifier: string) =>
  `export const loaded = await import(${JSON.stringify(specifier)});\n`;

runFamily(
  "R11",
  {
    "R11.host-node-specifier": async () =>
      expect(await errors(dynamic("node:child_process"), hostFile)).toEqual([
        "no-restricted-syntax",
      ]),
    "R11.host-bare-specifier": async () =>
      expect(await errors(dynamic("child_process"), hostFile)).toEqual([
        "no-restricted-syntax",
      ]),
    "R11.kernel-specifiers": async () => {
      for (const file of kernelFiles)
        for (const specifier of ["node:child_process", "child_process"])
          expect(await errors(dynamic(specifier), file)).toEqual([
            "no-restricted-syntax",
          ]);
    },
    "R11.path-twin-clean": async () => {
      for (const file of [hostFile, ...kernelFiles])
        expect(await errors(dynamic("node:path"), file)).toEqual([]);
    },
    "R11.existing-controls-red": async () => {
      expect(
        await errors(
          'import { spawn } from "node:child_process";\nexport { spawn };\n',
          hostFile,
        ),
      ).toContain("no-restricted-imports");
      for (const call of ["Bun.spawn", "Bun.spawnSync", "Bun.$"])
        expect(
          await errors(`export const start = ${call};\n`, hostFile),
        ).toContain("no-restricted-properties");
    },
  },
  60000,
);
