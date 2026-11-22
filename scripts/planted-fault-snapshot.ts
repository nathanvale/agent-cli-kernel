import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const snapshotAuthor = {
  GIT_AUTHOR_NAME: "fault-replay",
  GIT_AUTHOR_EMAIL: "fault-replay@localhost",
  GIT_COMMITTER_NAME: "fault-replay",
  GIT_COMMITTER_EMAIL: "fault-replay@localhost",
};

export type RunGit = (
  root: string,
  args: readonly string[],
  extra?: Readonly<Record<string, string>>,
) => string;

function isMissingEntryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!Object.hasOwn(error, "code")) return false;
  return Reflect.get(error, "code") === "ENOENT";
}

function seedScratchIndex(
  root: string,
  scratchIndex: string,
  env: Readonly<Record<string, string>>,
  gitOrThrow: RunGit,
): void {
  const existing = resolve(
    root,
    gitOrThrow(root, ["rev-parse", "--git-path", "index"]).trim(),
  );
  try {
    copyFileSync(existing, scratchIndex);
  } catch (error) {
    if (!isMissingEntryError(error)) throw error;
    gitOrThrow(root, ["read-tree", "HEAD"], env);
  }
}

export function snapshotWorkingTree(root: string, gitOrThrow: RunGit): string {
  if (
    gitOrThrow(root, ["status", "--porcelain=v1", "--untracked-files=normal"], {
      GIT_OPTIONAL_LOCKS: "0",
    }) === ""
  )
    return gitOrThrow(root, ["rev-parse", "HEAD"]).trim();
  const folder = mkdtempSync(join(tmpdir(), "fault-replay-index-"));
  try {
    const scratchIndex = join(folder, "index");
    const env = { GIT_INDEX_FILE: scratchIndex };
    seedScratchIndex(root, scratchIndex, env, gitOrThrow);
    gitOrThrow(root, ["add", "--all"], env);
    const tree = gitOrThrow(root, ["write-tree"], env).trim();
    if (tree === gitOrThrow(root, ["rev-parse", "HEAD^{tree}"]).trim())
      return gitOrThrow(root, ["rev-parse", "HEAD"]).trim();
    return gitOrThrow(
      root,
      ["commit-tree", tree, "-p", "HEAD", "-m", "fault-replay: working tree"],
      snapshotAuthor,
    ).trim();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
