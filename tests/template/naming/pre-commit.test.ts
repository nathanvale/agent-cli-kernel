import { afterAll, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { processWatchdog } from "../../support/process.ts";
import {
  fixtureRepository,
  git,
  gitOutcome,
  removeFixtureTrees,
  repository,
  write,
  writeRecordedHits,
} from "./fixture-tree.ts";

afterAll(removeFixtureTrees);

async function treeWithCommitHook(): Promise<string> {
  const tree = await fixtureRepository();
  symlinkSync(join(repository, "node_modules"), join(tree, "node_modules"));
  await git(tree, "config", "core.hooksPath", ".githooks");
  return tree;
}

async function commitCount(tree: string): Promise<string> {
  const { stdout } = await gitOutcome(tree, "rev-list", "--count", "HEAD");
  return stdout.trim();
}

async function commitNew(tree: string, path: string) {
  write(tree, path, "notes\n");
  await git(tree, "add", "--", path);
  const commit = await gitOutcome(tree, "commit", "--quiet", "-m", "notes");
  return {
    exit: commit.exit,
    stderr: commit.stderr,
    committed: (await commitCount(tree)) === "2",
  };
}

test(
  "PC.a a staged new file whose name is refused stops the commit, naming the cause and the repair",
  async () => {
    const tree = await treeWithCommitHook();
    expect(await commitNew(tree, "docs/mutation-notes.md")).toEqual({
      exit: 1,
      stderr: [
        'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: rename it with the glossary word.',
        "pre-commit: the names check failed on the staged names (above). Repair: rename each name it lists as its line says, using git mv so the old name leaves the commit too, and commit again. Done when bun run check:names --staged passes.",
        "",
      ].join("\n"),
      committed: false,
    });
  },
  processWatchdog(7),
);

test(
  "PC.b a staged new file whose recorded hit is only an unstaged edit stops the commit",
  async () => {
    const tree = await treeWithCommitHook();
    writeRecordedHits(tree, [
      { path: "docs/host.md", word: "host", reason: "fixture" },
    ]);
    expect(await commitNew(tree, "docs/host.md")).toEqual({
      exit: 1,
      stderr: [
        'docs/host.md uses "host" with no qualifier. Repair: add a word that says which host it is.',
        "pre-commit: the names check failed on the staged names (above). Repair: rename each name it lists as its line says, using git mv so the old name leaves the commit too, and commit again. Done when bun run check:names --staged passes.",
        "",
      ].join("\n"),
      committed: false,
    });
  },
  processWatchdog(7),
);

test(
  "a staged new file with a clean name is committed",
  async () => {
    const tree = await treeWithCommitHook();
    expect(await commitNew(tree, "docs/planted-fault-notes.md")).toMatchObject({
      exit: 0,
      committed: true,
    });
  },
  processWatchdog(7),
);

test(
  "PC.c the pre-commit type check uses the staged contents of a partially staged file",
  async () => {
    const tree = await treeWithCommitHook();
    const path = "src/index.ts";
    const valid = "export const value: number = 1;\n";
    const invalid = 'export const value: number = "one";\n';
    write(
      tree,
      "eslint.config.mjs",
      'import { parser } from "typescript-eslint";\n\nexport default [{ files: ["**/*.ts"], languageOptions: { parser } }];\n',
    );
    write(
      tree,
      "tsconfig.json",
      '{\n\t"compilerOptions": { "types": [] },\n\t"files": ["src/index.ts"]\n}\n',
    );
    write(tree, path, invalid);
    await git(tree, "add", "--", "eslint.config.mjs", "tsconfig.json", path);
    write(tree, path, valid);

    const refused = await gitOutcome(tree, "commit", "--quiet", "-m", "value");
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain(
      "pre-commit: TypeScript rejected the staged tree (above). Repair: fix the type errors and stage the repaired files. Done when git commit passes the staged type check.",
    );
    expect(stripVTControlCharacters(refused.stderr)).toContain(
      "error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    expect(await commitCount(tree)).toBe("1");
    expect(await gitOutcome(tree, "show", `:${path}`)).toMatchObject({
      exit: 0,
      stdout: invalid,
    });

    await git(tree, "add", "--", path);
    write(tree, path, invalid);
    await git(tree, "commit", "--quiet", "-m", "value");
    expect(await gitOutcome(tree, "show", `HEAD:${path}`)).toMatchObject({
      exit: 0,
      stdout: valid,
    });
    expect(await Bun.file(join(tree, path)).text()).toBe(invalid);
  },
  processWatchdog(11),
);
