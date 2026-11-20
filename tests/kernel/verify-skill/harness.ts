import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

export const repository = join(import.meta.dir, "../../..");
export const skill = join(repository, "skills/verify-agent-cli");
export const helperEntry = join(skill, "helper/cli.ts");
export const frontDoor = join(skill, "verify.ts");
export const targetEntry = join(import.meta.dir, "fixtures/target-cli.ts");
export const liarEntry = join(import.meta.dir, "fixtures/liar-cli.ts");
export const brokenEntry = join(import.meta.dir, "fixtures/broken-cli.ts");
export const helperBound = 30_000;

export type World = {
  readonly state: string;
  readonly repo: string;
  readonly runs: string;
};

const made: string[] = [];

export function releaseWorlds(): void {
  for (const folder of made.splice(0))
    rmSync(folder, { recursive: true, force: true });
}

export function world(): World {
  const folder = testFolder("kernel-verify-skill-");
  made.push(folder);
  const repo = join(folder, "repo");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ dependencies: { "agent-cli-kernel": "test" } }),
  );
  symlinkSync(repository, join(repo, "node_modules", "agent-cli-kernel"));
  const state = join(folder, "state");
  mkdirSync(state);
  return { state, repo, runs: join(state, "verify-agent-cli", "runs") };
}

export function environment(at: World): Record<string, string | undefined> {
  return { ...process.env, XDG_STATE_HOME: at.state };
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

export function field(value: unknown, ...names: readonly string[]): unknown {
  let current = value;
  for (const name of names) {
    if (typeof current !== "object" || current === null) return undefined;
    current = new Map(Object.entries(current)).get(name);
  }
  return current;
}

export type Helped = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: unknown;
};

export async function helper(
  at: World,
  ...argv: readonly string[]
): Promise<Helped> {
  const ran = await spawnBounded(
    [process.execPath, helperEntry, ...argv, "--json"],
    { cwd: at.repo, env: environment(at), boundMilliseconds: helperBound },
  );
  return { ...ran, result: field(parsed(ran.stdout), "result") };
}

export function resultCause(helped: Helped): unknown {
  return field(helped.result, "causeCode");
}

export function readJson(path: string): unknown {
  return parsed(readFileSync(path, "utf8"));
}
