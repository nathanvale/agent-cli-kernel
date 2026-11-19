import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { write } from "../../support/fixture-files.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { typecheckTree } from "../kernel-repair/harness.ts";
import { exampleFiles, repository } from "./example-files.ts";

const kernelSource = join(repository, "kernel");
const baseRoots = ["src/kernel", "config/kernel"];
const treeBound = 120_000;
const example = exampleFiles();

let built: Promise<string> | undefined;

afterAll(async () => {
  if (built) await rm(await built, { recursive: true, force: true });
});

async function build(): Promise<string> {
  const tree = testFolder("kernel-author-guide-");
  for (const root of baseRoots)
    await cp(join(kernelSource, root), join(tree, root), { recursive: true });
  for (const [path, text] of example) write(tree, path, text);
  await symlink(join(repository, "node_modules"), join(tree, "node_modules"));
  await writeFile(
    join(tree, "tsconfig.json"),
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
  );
  await writeFile(
    join(tree, "eslint.config.mjs"),
    [
      'import { kernelLint } from "./config/kernel/eslint.mjs";',
      "export default kernelLint({",
      "  rootDir: import.meta.dirname,",
      '  srcDir: "src",',
      '  testDirs: ["tests"],',
      "  addons: [],",
      "});",
      "",
    ].join("\n"),
  );
  return tree;
}

function generatedRepository(): Promise<string> {
  built ??= build();
  return built;
}

describe("the author guide's example, built as a generated repository with the base stamp roots", () => {
  test("the base stamp roots it copies are the ones kernel-declaration.json names", () => {
    const declaration: unknown = JSON.parse(
      readFileSync(
        join(kernelSource, "config/kernel/kernel-declaration.json"),
        "utf8",
      ),
    );
    expect(declaration).toMatchObject({ base: { roots: baseRoots } });
  });

  test(
    "it compiles under the repository's compiler settings",
    async () => {
      const run = await typecheckTree(await generatedRepository());
      expect({ exit: run.exit, output: run.stdout + run.stderr }).toEqual({
        exit: 0,
        output: "",
      });
    },
    treeBound,
  );

  test(
    "the stamped lint reads every example file and reports nothing",
    async () => {
      const tree = await generatedRepository();
      const results = await new ESLint({ cwd: tree }).lintFiles(["."]);
      const read = results.map((result) => relative(tree, result.filePath));
      for (const path of example.keys()) expect(read).toContain(path);
      expect(
        results.flatMap((result) =>
          result.messages.map(
            (message) =>
              `${relative(tree, result.filePath)}:${String(message.line)} ${String(message.ruleId)} ${message.message}`,
          ),
        ),
      ).toEqual([]);
    },
    treeBound,
  );

  test(
    "its own tests pass, in process and through its real entry file",
    async () => {
      const run = await spawnBounded([process.execPath, "test"], {
        cwd: await generatedRepository(),
        boundMilliseconds: treeBound - 10_000,
      });
      const summary = `${run.stdout}\n${run.stderr}`;
      expect({
        exit: run.exit,
        ran: / [1-9][0-9]* pass\n/.test(summary),
        failed: / 0 fail\n/.test(summary),
        files: summary.includes(" across 2 files."),
      }).toEqual({ exit: 0, ran: true, failed: true, files: true });
    },
    treeBound,
  );
});
