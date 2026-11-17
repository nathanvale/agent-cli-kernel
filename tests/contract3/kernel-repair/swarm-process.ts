import { existsSync, readFileSync } from "node:fs";
import { exitBound } from "../lifecycle/harness.ts";

const entry = new URL("swarm-cli.ts", import.meta.url).pathname;

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
    readonly signalAt?: SignalAt;
    readonly processGroup?: boolean;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  exit: number;
  firstByteAt?: number | undefined;
}> {
  const bound = options.boundMilliseconds ?? exitBound;
  const child = Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdout: "pipe",
    stderr: "pipe",
    detached: options.processGroup === true,
  });
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
  const readStdout = async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of child.stdout) {
      firstByteAt ??= Date.now();
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), bound);
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
  clearInterval(poll);
  if (finished === "expired") {
    if (options.processGroup !== true) child.kill("SIGKILL");
    else
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
      }
    await child.exited;
    throw new Error(`${argv.join(" ")} did not exit within ${bound} ms.`);
  }
  const [stdout, stderr, exit] = finished;
  return { stdout, stderr, exit, firstByteAt };
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
    ...(signalAt ? { signalAt } : {}),
  });
  return { ...run, result: resultOf(run.stdout) };
}
