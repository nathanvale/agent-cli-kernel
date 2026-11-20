import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { write } from "../../support/fixture-files.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { typecheckTree } from "../kernel-repair/harness.ts";
import { exampleFiles, packageName, repository } from "./example-files.ts";

const treeBound = 120_000;
const example = exampleFiles();
const folders: string[] = [];
let built: Promise<string> | undefined;

afterAll(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

function ownedFolder(prefix: string): string {
  const folder = testFolder(prefix);
  folders.push(folder);
  return folder;
}

async function build(tree: string): Promise<string> {
  for (const [path, text] of example) write(tree, path, text);
  const modules = join(tree, "node_modules");
  await mkdir(modules);
  for (const name of await readdir(join(repository, "node_modules")))
    await symlink(join(repository, "node_modules", name), join(modules, name));
  await symlink(repository, join(modules, packageName));
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
      `import { kernelLint } from "${packageName}/lint";`,
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

function consumer(): Promise<string> {
  built ??= build(ownedFolder("kernel-author-guide-"));
  return built;
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "nothing was thrown";
}

describe("the author guide's example, laid out as a repository that depends on the kernel package", () => {
  test(
    "it compiles under the repository's compiler settings",
    async () => {
      const run = await typecheckTree(await consumer());
      expect({ exit: run.exit, output: run.stdout + run.stderr }).toEqual({
        exit: 0,
        output: "",
      });
    },
    treeBound,
  );

  test(
    "the kernel's lint, loaded from the package, reads every example file and reports nothing",
    async () => {
      const tree = await consumer();
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
        cwd: await consumer(),
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

  test("an example file stored without the .txt ending is refused", () => {
    const folder = ownedFolder("kernel-author-guide-example-");
    write(folder, "src/a.ts.txt", "const a = 1;\n");
    expect([...exampleFiles(folder).keys()]).toEqual(["src/a.ts"]);
    write(folder, "src/b.ts", "const b = 2;\n");
    expect(thrownMessage(() => exampleFiles(folder))).toBe(
      "src/b.ts is in the example folder without the .txt ending. Repair: store each example file as <path in a repository that depends on the kernel>.txt.",
    );
  });
});
