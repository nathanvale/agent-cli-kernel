import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { type RecordedHit, recordedHitsFile } from "../../scripts/glossary.ts";
import { spawnBounded } from "../support/process.ts";
import { testFolder } from "../support/test-folder.ts";

const repository = join(import.meta.dir, "../..");

const glossary = `# Fixture glossary

**Planted fault**:
A deliberate break in a guard.
_Avoid_: mutant, mutation

**Recorded hit**:
A violation listed so that its check passes.
_Avoid_: known hit, allowlist

_Qualify_: host, proof
`;
const sources = ["scripts/check-names.ts", "scripts/glossary.ts"];
const folders: string[] = [];
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const callersRepositoryLocation = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
]);
const { scripts: production } = (await Bun.file(
  join(repository, "package.json"),
).json()) as { scripts: Record<string, string> };

export function removeFixtureTrees(): void {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function fixtureTree(recorded: readonly RecordedHit[] = []): string {
  const folder = testFolder("names-tree-");
  folders.push(folder);
  const root = join(folder, "tree");
  for (const path of sources) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  write(root, "GLOSSARY.md", glossary);
  write(root, recordedHitsFile, JSON.stringify({ hits: recorded }));
  write(
    root,
    "package.json",
    JSON.stringify({ scripts: { "check:names": production["check:names"] } }),
  );
  return root;
}

function run(argv: readonly string[], cwd: string) {
  return spawnBounded(argv, {
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !callersRepositoryLocation.has(name),
        ),
      ),
      ...gitEnv,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

export async function git(root: string, ...args: string[]): Promise<void> {
  const { exit, stderr } = await run(["git", ...args], root);
  if (exit !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
}

export function checkNames(root: string, args: readonly string[]) {
  return run(
    [process.execPath, "run", "--silent", "check:names", ...args],
    root,
  );
}
