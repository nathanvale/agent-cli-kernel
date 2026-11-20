import { existsSync, readFileSync } from "node:fs";
import { exitBound } from "../lifecycle/harness.ts";

export const entry = new URL("swarm-cli.ts", import.meta.url).pathname;

export type ScenarioRun = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: Readonly<Record<string, unknown>> | undefined;
};

function resultOf(stdout: string): ScenarioRun["result"] {
  if (stdout.trim() === "") return undefined;
  const envelope: unknown = JSON.parse(stdout);
  const result: unknown =
    typeof envelope === "object" && envelope !== null
      ? Reflect.get(envelope, "result")
      : undefined;
  return typeof result === "object" && result !== null
    ? Object.fromEntries(Object.entries(result))
    : undefined;
}

// Interface: thrown when a run passes its bound, with the output it wrote
// before it was killed.
export class BoundPassed extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const killedExitBound = 3_000;

async function settledWithin<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T | "expired"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), milliseconds);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function killRun(
  child: { readonly pid: number; readonly kill: (signal: "SIGKILL") => void },
  group: boolean,
): void {
  if (!group) return child.kill("SIGKILL");
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
  }
}

export type SignalAt = {
  readonly ledger: string;
  readonly line: string;
  readonly signal: "SIGTERM" | "SIGINT" | "SIGHUP";
};
export async function spawnBounded(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly boundMilliseconds?: number;
    readonly signalAt?: SignalAt | undefined;
    readonly processGroup?: boolean;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  exit: number;
  signal?: NodeJS.Signals | number;
  firstByteAt?: number | undefined;
}> {
  const bound = options.boundMilliseconds ?? exitBound;
  const streams = {
    stdout: "pipe",
    stderr: "pipe",
    detached: options.processGroup === true,
  } as const;
  const placed =
    options.cwd === undefined ? streams : { ...streams, cwd: options.cwd };
  const child = Bun.spawn(
    [...argv],
    options.env === undefined ? placed : { ...placed, env: { ...options.env } },
  );
  const barrier = options.signalAt;
  const poll = barrier
    ? setInterval(() => {
        const lines = existsSync(barrier.ledger)
          ? readFileSync(barrier.ledger, "utf8").split("\n")
          : [];
        if (!lines.includes(barrier.line)) return;
        clearInterval(poll);
        child.kill(barrier.signal);
      }, 5)
    : undefined;
  let firstByteAt: number | undefined;
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drained = Promise.all([
    (async () => {
      for await (const chunk of child.stdout) {
        firstByteAt ??= Date.now();
        stdoutChunks.push(chunk);
      }
    })(),
    (async () => {
      for await (const chunk of child.stderr) stderrChunks.push(chunk);
    })(),
  ]);
  const text = (chunks: Uint8Array[]) =>
    new TextDecoder().decode(Buffer.concat(chunks));
  const finished = await settledWithin(
    Promise.all([child.exited, drained]),
    bound,
  );
  clearInterval(poll);
  if (finished === "expired") {
    killRun(child, options.processGroup === true);
    await settledWithin(Promise.all([child.exited, drained]), killedExitBound);
    if (child.exitCode === null && child.signalCode === null)
      throw new Error(
        `${argv.join(" ")} did not exit within ${killedExitBound} ms of SIGKILL, sent when its ${bound} ms bound passed.`,
      );
    throw new BoundPassed(
      `${argv.join(" ")} did not exit within ${bound} ms.`,
      text(stdoutChunks),
      text(stderrChunks),
    );
  }
  const [exit] = finished;
  const stdout = text(stdoutChunks);
  const stderr = text(stderrChunks);
  const signal = child.signalCode;
  return {
    stdout,
    stderr,
    exit,
    ...(signal === null ? {} : { signal }),
    firstByteAt,
  };
}

export function processWatchdog(runs: number): number {
  return runs * exitBound + 10_000;
}

export async function runScenario(
  scenario: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
  path = entry,
  signalAt?: SignalAt,
): Promise<ScenarioRun> {
  const run = await spawnBounded([process.execPath, path, scenario, ...argv], {
    env: { ...process.env, ...env },
    signalAt,
  });
  return { ...run, result: resultOf(run.stdout) };
}
