import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { exampleFiles } from "../author-guide/example-files.ts";
import { testFolder } from "../../support/test-folder.ts";

export const repository = join(import.meta.dir, "../../..");
export const skill = join(repository, "skills/verify-cli");
export const helperEntry = join(skill, "helper/cli.ts");
export const checkEntry = join(skill, "verify.ts");
export const fixtures = join(import.meta.dir, "fixtures");
export const pinnedCommit = "5b89b1fd98a5dcc6f7e7924bb63f6d1756c3d795";
const made: string[] = [];

export const helperBound = 30_000;
export const checkBound = 90_000;

export function watchdog(helperRuns: number, checkRuns = 0): number {
  return helperRuns * helperBound + checkRuns * checkBound + 10_000;
}

export function ownedFolder(prefix: string): string {
  const folder = testFolder(prefix);
  made.push(folder);
  return folder;
}

export function releaseWorlds(): void {
  for (const folder of made.splice(0))
    rmSync(folder, { recursive: true, force: true });
}

export type World = {
  readonly folder: string;
  readonly repo: string;
  readonly example: string;
  readonly env: Record<string, string | undefined>;
};

export function fixture(at: World, name: string): string {
  return join(at.repo, "fixtures", name);
}

export function writePackage(
  repo: string,
  fields: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({
      name: "generated",
      private: true,
      type: "module",
      packageManager: `bun@${Bun.version}`,
      dependencies: {
        "agent-cli-kernel": `github:nathanvale/agent-cli-kernel#${pinnedCommit}`,
      },
      ...fields,
    })}\n`,
  );
}

export function world(): World {
  const folder = ownedFolder("kernel-verify-skill-");
  const repo = join(folder, "repo");
  for (const [path, text] of exampleFiles()) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  writePackage(repo);
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(repository, join(repo, "node_modules", "agent-cli-kernel"));
  cpSync(fixtures, join(repo, "fixtures"), { recursive: true });
  writeFileSync(join(repo, "fixtures", "greeting.txt"), "Hello from start.\n");
  return {
    folder,
    repo,
    example: join(repo, "src", "cli.ts"),
    env: { ...process.env, XDG_STATE_HOME: join(folder, "xdg-state") },
  };
}

export function runFolder(at: World, name: string): string {
  return join(at.folder, "runs", name);
}

export function scenarioFile(at: World, scenario: unknown): string {
  const path = join(
    at.folder,
    "scenarios",
    `${String(field(scenario, "feature"))}-${String(made.length)}-${String(Date.now())}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(scenario, null, 2)}\n`);
  return path;
}

export const readOnlyScenario = {
  schema: "verify-scenario/1",
  feature: "read-only-command",
  steps: [
    {
      name: "show-known-planet",
      argv: ["show", "mars", "--json"],
      expect: {
        exitCode: 0,
        stderr: "",
        result: {
          commandIdentity: "moons.show",
          causeCode: "SUCCESS_UNCHANGED",
          data: { planet: "mars", moons: 2 },
        },
      },
    },
    {
      name: "show-unknown-planet",
      argv: ["show", "pluto"],
      expect: {
        exitCode: 3,
        stdout: "",
        stderr: "moons: No planet named pluto. [DOMAIN_MOONS_UNKNOWN_PLANET]\n",
      },
    },
  ],
} as const;

export function parsed(text: string): unknown {
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

export function readJson(path: string): unknown {
  return parsed(readFileSync(path, "utf8"));
}

export type Spawned = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: NodeJS.Signals | number | undefined;
};

export type Helped = Spawned & { readonly result: unknown };

export async function helper(
  at: World,
  argv: readonly string[],
  env: Record<string, string | undefined> = at.env,
): Promise<Helped> {
  const ran = await spawnBounded(
    [process.execPath, helperEntry, ...argv, "--json"],
    { cwd: at.repo, env, boundMilliseconds: helperBound },
  );
  return { ...ran, result: field(parsed(ran.stdout), "result") };
}

export function causeOf(helped: Helped): unknown {
  return field(helped.result, "causeCode");
}

export function check(
  at: World,
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly entry?: string;
    readonly env?: Record<string, string | undefined>;
  } = {},
): Promise<Spawned> {
  return spawnBounded(
    [process.execPath, options.entry ?? checkEntry, ...argv],
    {
      cwd: options.cwd ?? at.repo,
      env: options.env ?? at.env,
      boundMilliseconds: checkBound,
    },
  );
}

export function envelopeIn(ran: Spawned): unknown {
  return parsed(ran.stdout);
}

export function rawFailIds(stderr: string): readonly string[] {
  return stderr
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => /^verify-cli: RAW FAIL ([a-z-]+): /.exec(line)?.[1] ?? line);
}

export function lsTree(folder: string): readonly string[] {
  if (!existsSync(folder)) return [];
  return [
    ...new Bun.Glob("**/*").scanSync({
      cwd: folder,
      dot: true,
      onlyFiles: false,
    }),
  ].sort();
}

function openWriter(path: string): number | undefined {
  try {
    return openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (field(error, "code") === "ENXIO") return undefined;
    throw error;
  }
}

export function releaseFifo(path: string): Promise<void> {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      let descriptor: number | undefined;
      try {
        descriptor = openWriter(path);
      } catch (error) {
        clearInterval(poll);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (descriptor !== undefined) {
        clearInterval(poll);
        try {
          writeSync(descriptor, "go");
        } finally {
          closeSync(descriptor);
        }
        resolve();
      } else if (Date.now() - started >= helperBound) {
        clearInterval(poll);
        reject(
          new Error(
            `No reader opened ${path} within ${String(helperBound)} ms.`,
          ),
        );
      }
    }, 5);
  });
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

export async function makeFifo(path: string): Promise<void> {
  const made = await spawnBounded(["mkfifo", path], {
    boundMilliseconds: helperBound,
  });
  if (made.exit !== 0) throw new Error(`mkfifo ${path} failed: ${made.stderr}`);
}

export function installedCopy(at: World): string {
  const installed = join(at.repo, "node_modules", "agent-cli-kernel");
  rmSync(installed);
  mkdirSync(installed);
  cpSync(join(repository, "package.json"), join(installed, "package.json"));
  cpSync(join(repository, "kernel"), join(installed, "kernel"), {
    recursive: true,
  });
  cpSync(skill, join(installed, "skills", "verify-cli"), { recursive: true });
  mkdirSync(join(at.repo, "node_modules", "@logtape"));
  for (const name of ["logtape", "redaction"])
    symlinkSync(
      join(repository, "node_modules", "@logtape", name),
      join(at.repo, "node_modules", "@logtape", name),
    );
  return join(installed, "skills", "verify-cli", "verify.ts");
}

export type KernelFault = {
  readonly file: string;
  readonly from: string;
  readonly to: string;
};

export function plantFault(at: World, fault: KernelFault): void {
  const path = join(at.repo, "node_modules", "agent-cli-kernel", fault.file);
  const text = readFileSync(path, "utf8");
  if (text.split(fault.from).length !== 2)
    throw new Error(`${fault.file} does not hold the planted text once.`);
  writeFileSync(path, text.replace(fault.from, fault.to));
}

export const changingScenario = {
  schema: "verify-scenario/1",
  feature: "changing-command",
  steps: [
    {
      name: "first-run",
      argv: ["save", "{scratch}/note", "--content", "proof", "--json"],
      expect: {
        exitCode: 0,
        stderr: "",
        result: {
          commandIdentity: "notes.save",
          causeCode: "SUCCESS_COMPLETED",
          transactionState: "completed",
          "effects.completed": ["note.write"],
        },
        files: [{ path: "{scratch}/note", content: "proof" }],
      },
    },
    {
      name: "second-run",
      argv: ["save", "{scratch}/note", "--content", "again", "--json"],
      expect: {
        exitCode: 0,
        stderr: "",
        result: { causeCode: "SUCCESS_COMPLETED" },
        files: [{ path: "{scratch}/note", content: "again" }],
      },
    },
    {
      name: "nothing-pending",
      argv: ["pending", "--json"],
      expect: {
        exitCode: 0,
        stderr: "",
        result: { causeCode: "SUCCESS_UNCHANGED", "data.unfinished.length": 0 },
      },
    },
    {
      name: "interrupted-run",
      timeoutMilliseconds: 3000,
      argv: ["save", "{scratch}/held", "--content", "hold", "--json"],
      expect: {
        exitCode: 143,
        timedOut: true,
        stdout: "",
        stderr: "",
        files: [{ path: "{scratch}/held", absent: true }],
      },
    },
    {
      name: "interruption-blocks",
      argv: ["save", "{scratch}/held", "--content", "again", "--json"],
      expect: {
        exitCode: 3,
        stderr: "",
        result: { causeCode: "DOMAIN_NOTES_UNRESOLVED" },
      },
    },
    {
      name: "interruption-is-listed",
      argv: ["pending", "--json"],
      expect: {
        exitCode: 0,
        stderr: "",
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          "data.unfinished.length": 1,
          "data.unfinished.0.commandIdentity": "notes.save",
        },
      },
    },
  ],
};
