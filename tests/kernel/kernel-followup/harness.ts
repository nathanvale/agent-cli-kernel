import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";

const repository = new URL("../../../", import.meta.url).pathname;

export async function materialiseKf(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "kernel-kf-"));
  const target = join(root, "kernel/src/addons/state");
  await mkdir(target, { recursive: true });
  const source = await readFile(
    new URL("fixtures/kf-cli.ts.txt", import.meta.url),
    "utf8",
  );
  const entry = join(target, "kf-cli.ts");
  await writeFile(
    entry,
    source
      .replaceAll("__KERNEL__", join(repository, "kernel/src/kernel"))
      .replaceAll("__ADDONS__", join(repository, "kernel/src/addons")),
  );
  return entry;
}

export type KfRun = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: Readonly<Record<string, unknown>> | undefined;
  readonly result: Readonly<Record<string, unknown>> | undefined;
  readonly ledger: readonly string[];
  readonly firstByte: number | undefined;
};

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

let sequence = 0;
export async function runKf(
  entry: string,
  scenario: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<KfRun> {
  const ledger = join(entry, "..", `ledger-${sequence++}.txt`);
  const child = await spawnBounded([process.execPath, entry, ...argv], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      KF_SCENARIO: scenario,
      KF_LEDGER: ledger,
      ...env,
    },
  });
  await Bun.sleep(1000);
  const all = (await readFile(ledger, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line !== "");
  const start = all.find((line) => line.startsWith("start "));
  const lines = all.filter((line) => !line.startsWith("start "));
  const envelope = argv.includes("--json")
    ? record(child.stdout.trim() === "" ? undefined : JSON.parse(child.stdout))
    : undefined;
  return {
    exit: child.exit,
    stdout: child.stdout,
    stderr: child.stderr,
    envelope,
    result: record(envelope?.result),
    ledger: lines,
    firstByte:
      start === undefined || child.firstByteAt === undefined
        ? undefined
        : child.firstByteAt - Number(start.slice("start ".length)),
  };
}

export function oneEnvelope(run: KfRun): boolean {
  return (
    run.stderr === "" &&
    run.stdout.endsWith("}\n") &&
    run.stdout.indexOf("\n") === run.stdout.length - 1 &&
    run.envelope !== undefined
  );
}
export function humanOneLine(run: KfRun): boolean {
  return (
    run.stdout === "" &&
    run.stderr.endsWith("\n") &&
    run.stderr.indexOf("\n") === run.stderr.length - 1
  );
}

export const emptyComplete = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
