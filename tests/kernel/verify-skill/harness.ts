import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { exitBound } from "../lifecycle/harness.ts";
import { testFolder } from "../../support/test-folder.ts";

export const repository = join(import.meta.dir, "../../..");
export const skill = join(repository, "skills/verify-cli");
export const helperEntry = join(skill, "helper/cli.ts");
export const frontDoor = join(skill, "verify.ts");
export const targetEntry = join(import.meta.dir, "fixtures/target-cli.ts");
export const liarEntry = join(import.meta.dir, "fixtures/liar-cli.ts");
export const brokenEntry = join(import.meta.dir, "fixtures/broken-cli.ts");
export const stubbornEntry = join(import.meta.dir, "fixtures/stubborn-cli.ts");
const made: string[] = [];

export const helperBound = exitBound;

export function watchdog(runs: number): number {
  return runs * helperBound + 10_000;
}

export function ownedFolder(prefix: string): string {
  const folder = testFolder(prefix);
  made.push(folder);
  return folder;
}

export function releaseFifo(path: string): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    writeSync(descriptor, "go");
  } finally {
    closeSync(descriptor);
  }
}

export function ledgeredPid(ledger: string): number {
  const line = readFileSync(ledger, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("pid "));
  const pid = Number(line?.slice("pid ".length));
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`${ledger} holds no pid line.`);
  return pid;
}

export type World = {
  readonly state: string;
  readonly repo: string;
  readonly runs: string;
};

export function releaseWorlds(): void {
  for (const folder of made.splice(0))
    rmSync(folder, { recursive: true, force: true });
}

export function world(): World {
  const folder = ownedFolder("kernel-verify-skill-");
  const repo = join(folder, "repo");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      dependencies: { "agent-cli-kernel": "test" },
      scripts: {
        where:
          'bun -e "process.stdout.write(process.cwd() + \\" \\" + process.env.HOME)"',
        hang: 'bun -e "setInterval(() => {}, 1000)"',
      },
    }),
  );
  symlinkSync(repository, join(repo, "node_modules", "agent-cli-kernel"));
  const state = join(folder, "state");
  mkdirSync(state);
  return { state, repo, runs: join(state, "verify-cli", "runs") };
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

export function ledgerHolds(
  ledger: string,
  line: string,
  boundMilliseconds: number,
): Promise<void> {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      let lines: readonly string[];
      try {
        lines = readFileSync(ledger, "utf8").split("\n");
      } catch {
        lines = [];
      }
      if (lines.includes(line)) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - started >= boundMilliseconds) {
        clearInterval(poll);
        reject(
          new Error(
            `${ledger} did not hold the line "${line}" within ${String(boundMilliseconds)} ms.`,
          ),
        );
      }
    }, 5);
  });
}

export function front(at: World, ...argv: readonly string[]) {
  return spawnBounded([process.execPath, frontDoor, ...argv], {
    cwd: at.repo,
    env: environment(at),
    boundMilliseconds: helperBound,
  });
}
