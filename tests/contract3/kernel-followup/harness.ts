import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitBound } from "../lifecycle/harness.ts";

// The test harness for the KF cases: it materialises the `kf` entry inside
// a disposable state add-on folder (only that folder may name the state add-on
// factory), runs it as a real child process with stdin closed, and reads the
// independent ledger 1 s after exit, so a late handler would have written to
// it (expectations, Conventions).
const repository = new URL("../../../", import.meta.url).pathname;

export async function materialiseKf(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "contract3-kf-"));
  const target = join(root, "starters/contract3/src/addons/state");
  await mkdir(target, { recursive: true });
  const source = await readFile(
    new URL("fixtures/kf-cli.ts.txt", import.meta.url),
    "utf8",
  );
  const entry = join(target, "kf-cli.ts");
  await writeFile(
    entry,
    source
      .replaceAll(
        "__KERNEL__",
        join(repository, "starters/contract3/src/kernel"),
      )
      .replaceAll(
        "__ADDONS__",
        join(repository, "starters/contract3/src/addons"),
      ),
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
  // Milliseconds from the CLI's own `start` ledger line (wall clock) to the
  // parent's receipt of the first stdout byte; undefined without either.
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
  const child = await spawnFirstByte([process.execPath, entry, ...argv], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    KF_SCENARIO: scenario,
    KF_LEDGER: ledger,
    ...env,
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

// As spawnBounded (bounded below the test timeout; a hang is killed and
// named), and it also records the wall-clock time of the first stdout byte.
async function spawnFirstByte(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
) {
  const child = Bun.spawn([...argv], {
    env: { ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let firstByteAt: number | undefined;
  const chunks: Uint8Array[] = [];
  const readStdout = async () => {
    for await (const chunk of child.stdout) {
      firstByteAt ??= Date.now();
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), exitBound);
  });
  const finished = await Promise.race([
    Promise.all([
      readStdout(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
    expired,
  ]);
  clearTimeout(timer);
  if (!finished) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(`${argv.join(" ")} did not exit within ${exitBound} ms.`);
  }
  const [stdout, stderr, exit] = finished;
  return { stdout, stderr, exit, firstByteAt };
}

// The KF Conventions: one envelope is exactly one JSON object and one "\n";
// stderr is 0 bytes (LIFE-1).
export function oneEnvelope(run: KfRun): boolean {
  return (
    run.stderr === "" &&
    run.stdout.endsWith("}\n") &&
    run.stdout.indexOf("\n") === run.stdout.length - 1 &&
    run.envelope !== undefined
  );
}
// Human one line: stdout 0 bytes; stderr exactly one "\n"-terminated line.
export function humanOneLine(run: KfRun): boolean {
  return (
    run.stdout === "" &&
    run.stderr.endsWith("\n") &&
    run.stderr.indexOf("\n") === run.stderr.length - 1
  );
}

// Independent oracle: the empty complete effects of the KF Conventions.
export const emptyComplete = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
