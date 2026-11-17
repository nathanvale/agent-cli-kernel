import { existsSync, readFileSync } from "node:fs";
import { type Child, startChild } from "../../scripts/process-runner.ts";

const exitBound = 20_000;

// Interface: once `ledger` holds the line `line`, `signal` goes to the child
// alone, as a terminal or CI runner would send it.
export type SignalAt = {
  readonly ledger: string;
  readonly line: string;
  readonly signal: "SIGTERM" | "SIGINT" | "SIGHUP";
};

// Interface: `reached` resolves once the ledger holds the line, and rejects
// naming both once the bound passes first. `stop` ends the wait unsettled.
export type LedgerWatch = {
  readonly reached: Promise<void>;
  readonly stop: () => void;
};

function holdsLine(ledger: string, line: string): boolean {
  return (
    existsSync(ledger) &&
    readFileSync(ledger, "utf8").split("\n").includes(line)
  );
}

export function watchLedger(
  ledger: string,
  line: string,
  boundMilliseconds: number,
): LedgerWatch {
  const started = Date.now();
  let poll: ReturnType<typeof setInterval> | undefined;
  const reached = new Promise<void>((resolve, reject) => {
    poll = setInterval(() => {
      if (holdsLine(ledger, line)) resolve();
      else if (Date.now() - started >= boundMilliseconds)
        reject(
          new Error(
            `${ledger} did not hold the line "${line}" within ${boundMilliseconds} ms.`,
          ),
        );
      else return;
      clearInterval(poll);
    }, 5);
  });
  return { reached, stop: () => clearInterval(poll) };
}

function signalOnLine(
  child: Child,
  barrier: SignalAt,
  boundMilliseconds: number,
): LedgerWatch {
  const watch = watchLedger(barrier.ledger, barrier.line, boundMilliseconds);
  watch.reached.then(
    () => child.signal(barrier.signal),
    () => {},
  );
  return watch;
}

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
  const watch =
    options.signalAt === undefined
      ? undefined
      : signalOnLine(child, options.signalAt, bound);
  try {
    const run = await child.finished;
    if (run.timedOut)
      throw new Error(`${argv.join(" ")} did not exit within ${bound} ms.`);
    return { stdout: run.stdout, stderr: run.stderr, exit: run.exitCode };
  } finally {
    watch?.stop();
  }
}

export function processWatchdog(runs: number): number {
  return runs * exitBound + 10_000;
}
