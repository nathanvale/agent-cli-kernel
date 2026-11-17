import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ESLint } from "eslint";
import { materialise, runFamily } from "./harness.ts";

let root = "";
let eslint: ESLint | undefined;
let hostFile = "";
let kernelFiles: readonly string[] = [];
beforeAll(async () => {
  root = await materialise();
  eslint = new ESLint({ cwd: root });
  await mkdir(join(root, "kernel/src/handlers"), {
    recursive: true,
  });
  hostFile = join(root, "kernel/src/handlers/control.ts");
  await writeFile(hostFile, "export {};\n");
  kernelFiles = [
    "kernel/src/kernel/types.ts",
    "kernel/src/kernel/index.ts",
    "kernel/src/kernel/validation/brands.ts",
  ].map((file) => join(root, file));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function errors(source: string, filePath: string) {
  if (!eslint) throw new Error("Lint tree not materialised.");
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
