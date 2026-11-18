import { afterAll, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Fault } from "../../scripts/planted-faults.ts";
import { testFolder } from "./test-folder.ts";

const repositoryLocation = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

const fixtureAuthor = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export const recordsPath = "tests/planted-faults/fault-records.json";

export const stepVariable = "FAULT_REPLAY_STEP_SECONDS";

export const unguarded = `export function limit(value: number): number {
  return value;
}
`;

export const guarded = `export function limit(value: number): number {
  if (Number.isNaN(value)) throw new TypeError("limit must be a number");
  return value;
}
`;

export const limitTests = `import { expect, test } from "bun:test";
import { limit } from "../src/limit.ts";

test("L.refuses NaN", () => {
  expect(() => limit(Number.NaN)).toThrow("limit must be a number");
});
test("L.refuses NaN twice", () => {
  expect(() => limit(Number.NaN)).toThrow("limit must be a number");
});
test("L.weak keeps a number", () => {
  expect(limit(1)).toBe(1);
});
`;

export function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !repositoryLocation.includes(name),
        ),
      ),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...fixtureAuthor,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function commit(
  root: string,
  subject: string,
  files: Record<string, string>,
): string {
  for (const [path, content] of Object.entries(files)) {
    write(root, path, content);
    git(root, "add", "--", path);
  }
  git(root, "commit", "--quiet", "-m", subject);
  return git(root, "rev-parse", "--short", "HEAD").trim();
}

export function worktrees(root: string): string[] {
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

export type Planted = {
  root: string;
  fix: string;
  id: string;
  patch: string;
  fault: Fault;
};

export function headOf(root: string): string {
  return git(root, "rev-parse", "HEAD").trim();
}

export function recorded(root: string, faults: readonly Fault[]): void {
  for (const fault of faults)
    if (!existsSync(join(root, fault.patch)))
      write(root, fault.patch, "unused\n");
  write(root, recordsPath, `${JSON.stringify(faults, null, 2)}\n`);
  git(root, "add", "--", "tests/planted-faults");
  git(root, "commit", "--quiet", "-m", "record the faults");
}

export async function captured<T>(run: () => Promise<T> | T) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    },
  );
  const stderr = spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    },
  );
  try {
    const result = await run();
    return { result, stdout: out.join(""), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

export async function rejection(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The call resolved, but the test expected it to reject.");
}

export const sample: Fault = {
  id: "abc1234-limit",
  patch: "tests/planted-faults/patches/abc1234-limit.patch",
  testFile: "tests/limit.test.ts",
  title: "^L\\.refuses ",
  source: "abc1234 fix: refuse a NaN limit",
};

export function createPlantedFaultFixture() {
  const folders: string[] = [];

  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true });
  });

  function folder(prefix: string): string {
    const path = testFolder(prefix);
    folders.push(path);
    return path;
  }

  function repository(prefix: string): string {
    const root = join(folder(prefix), "repo");
    mkdirSync(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    return root;
  }

  function planted(
    options: {
      tests?: string;
      manifest?: string;
      title?: string;
      elsewhere?: string;
    } = {},
  ): Planted {
    const root = repository("planted-faults-fixture-");
    commit(root, "base", {
      "package.json":
        options.manifest ?? JSON.stringify({ name: "fixture", private: true }),
      ".gitignore": "node_modules/\n",
      "src/limit.ts": unguarded,
    });
    const fix = commit(root, "fix: refuse a NaN limit", {
      "src/limit.ts": guarded,
      "tests/limit.test.ts": options.tests ?? limitTests,
      ...(options.elsewhere === undefined
        ? {}
        : { "tests/elsewhere.test.ts": options.elsewhere }),
    });
    const id = `${fix}-limit`;
    const patch = git(root, "diff", "HEAD", "HEAD~1", "--", "src/limit.ts");
    const fault: Fault = {
      id,
      patch: `tests/planted-faults/patches/${id}.patch`,
      testFile: "tests/limit.test.ts",
      title: options.title ?? "^L\\.refuses ",
      source: `${fix} fix: refuse a NaN limit`,
    };
    write(root, fault.patch, patch);
    return { root, fix, id, patch, fault };
  }

  async function isolated<T>(run: () => Promise<T> | T) {
    const scratch = folder("planted-faults-scratch-");
    const changes: Record<string, string | undefined> = {
      TMPDIR: scratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...Object.fromEntries(
        repositoryLocation.map((name) => [name, undefined]),
      ),
    };
    const before = Object.fromEntries(
      Object.keys(changes).map((name) => [name, process.env[name]]),
    );
    const set = (values: Record<string, string | undefined>) => {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    };
    set(changes);
    try {
      const result = await captured(run);
      return { ...result, leftovers: readdirSync(scratch) };
    } finally {
      set(before);
    }
  }

  return { folder, isolated, planted, repository };
}
