import { afterAll, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { processWatchdog } from "../support/process.ts";
import {
  fixtureRepository,
  git,
  gitOutcome,
  removeFixtureTrees,
  repository,
  write,
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
        'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Rename it with the glossary word.',
        "pre-commit: the names check failed on the staged names (above). Rename each name it lists as its line says, stage the rename with git add, and commit again. Done when bun run check:names --staged passes.",
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
