import { afterEach } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testFolder } from "./test-folder.ts";

export const ROOT = resolve(import.meta.dir, "../..");

export function parsePackage(text: string) {
  const value: unknown = JSON.parse(text);
  return value as {
    name: string;
    packageManager: string;
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    catalog: Record<string, string>;
  };
}

export interface Invocation {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export function runIn(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Invocation {
  return runCommand(cwd, [process.execPath, ...args], env);
}

export function runCommand(
  cwd: string,
  command: string[],
  env: Record<string, string> = {},
): Invocation {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

export function invoke(...args: string[]): Invocation {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/bootstrap.ts", ...args],
    {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

export async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

export function requireSuccess(result: Invocation, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit ${result.exitCode}: ${result.stderr}\n${result.stdout}`,
    );
  }
}

export function commitGeneratedFiles(
  destination: string,
  files: readonly string[],
): void {
  requireSuccess(
    runCommand(destination, ["git", "init", "--quiet"]),
    "git init",
  );
  requireSuccess(
    runCommand(destination, ["git", "add", "--", ...files]),
    "git add generated files",
  );
  requireSuccess(
    runCommand(destination, [
      "git",
      "-c",
      "user.name=CLI template qualification",
      "-c",
      "user.email=cli-template@example.test",
      "commit",
      "--quiet",
      "-m",
      "qualify generated starter",
    ]),
    "git commit generated files",
  );
}

export function bootstrapCliFixture() {
  const scratchRoots: string[] = [];

  function temporaryRoot(): string {
    const root = testFolder("bootstrap-cli-");
    scratchRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(
      scratchRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  return temporaryRoot;
}
