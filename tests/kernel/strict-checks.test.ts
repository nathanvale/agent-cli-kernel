import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { lintRuleFolder } from "../support/lint-rule-folder.ts";
import { probeBatch } from "./locks/lock-probes.ts";

const root = resolve(import.meta.dir, "../..");
const probe = probeBatch("kernel-strict-checks-");

const unreachable = probe(
  "export function unreachableAfterReturn(): number {\n  return 1;\n  const dead = 2;\n  return dead;\n}\n",
);
const reachable = probe(
  "export function reachableReturn(): number {\n  const alive = 2;\n  return alive;\n}\n",
);
const timeout = probe.timeout();

let probes: string;
let probeFile: string;

beforeAll(async () => {
  probes = lintRuleFolder(resolve(root, "tests/kernel"));
  probeFile = `${probes}/strict-checks.ts`;
  await writeFile(probeFile, "export {};\n");
});

afterAll(async () => {
  await rm(probes, { recursive: true, force: true });
});

test(
  "allowUnreachableCode false refuses unreachable code after return under both compilers and admits reachable code",
  async () => {
    for (const compiler of ["native", "lint-view"] as const) {
      const rejected = await unreachable.compile(compiler);
      expect(rejected.exit).not.toBe(0);
      expect(rejected.stderr).toBe("");
      expect(rejected.diagnostics).toEqual([
        { file: unreachable.file, line: 3, code: 7027 },
      ]);
      expect(await reachable.compile(compiler)).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
    }
  },
  timeout,
);

test("no-unused-vars refuses plain leading or trailing unused parameters and accepts underscore-prefixed ones", async () => {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: resolve(root, "eslint.config.mjs"),
  });
  const check = async (code: string) => {
    const [result] = await eslint.lintText(code, { filePath: probeFile });
    return (result?.messages ?? [])
      .filter((item) => item.ruleId === "@typescript-eslint/no-unused-vars")
      .map((item) => item.message);
  };

  expect(
    await check(
      "export function leadingUnused(unused: number, used: number): number {\n  return used;\n}\n",
    ),
  ).toHaveLength(1);
  expect(
    await check(
      "export function trailingUnused(used: number, unused: number): number {\n  return used;\n}\n",
    ),
  ).toHaveLength(1);
  expect(
    await check(
      "export function leadingUnderscore(_unused: number, used: number): number {\n  return used;\n}\n",
    ),
  ).toEqual([]);
  expect(
    await check(
      "export function trailingUnderscore(used: number, _unused: number): number {\n  return used;\n}\n",
    ),
  ).toEqual([]);
});
