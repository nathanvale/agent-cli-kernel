import { existsSync, readFileSync } from "node:fs";
import { startChild } from "../../scripts/child-env.ts";

const exitBound = 20_000;

// Interface: once `ledger` holds the line `line`, `signal` goes to the child
// alone, as a terminal or CI runner would send it.
export type SignalAt = {
  readonly ledger: string;
  readonly line: string;
  readonly signal: "SIGTERM" | "SIGINT" | "SIGHUP";
};

// Interface: a run that outlives its bound is killed at once with SIGKILL and
// fails naming the bound, so a hung case leaves no fixture process behind.
export async function spawnBounded(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly boundMilliseconds?: number;
    readonly signalAt?: SignalAt | undefined;
    readonly processGroup?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const bound = options.boundMilliseconds ?? exitBound;
  const child = startChild(argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    ownGroup: options.processGroup === true,
    limitMilliseconds: bound,
    graceMilliseconds: 0,
  });
  const barrier = options.signalAt;
  const poll = barrier
    ? setInterval(() => {
        const lines = existsSync(barrier.ledger)
          ? readFileSync(barrier.ledger, "utf8").split("\n")
          : [];
        if (!lines.includes(barrier.line)) return;
        clearInterval(poll);
        child.signal(barrier.signal);
      }, 5)
    : undefined;
  try {
    const run = await child.finished;
    if (run.timedOut)
      throw new Error(`${argv.join(" ")} did not exit within ${bound} ms.`);
    return { stdout: run.stdout, stderr: run.stderr, exit: run.exitCode };
  } finally {
    clearInterval(poll);
  }
}

export function processWatchdog(runs: number): number {
  return runs * exitBound + 10_000;
}
