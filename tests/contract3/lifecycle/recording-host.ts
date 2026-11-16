// Component helpers for the findings round (S02, S04, T02 b, T05, T06). The
// recording host is kernel-internal test wiring: it records every write and
// exit request, declines to exit, and lets the test deliver a stop signal.
import { appendFileSync } from "node:fs";
import { jest } from "bun:test";
import {
  command,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
import type {
  ProgramRequest,
  ProgramsCapability,
} from "../../../starters/contract3/src/kernel/index.ts";
import type {
  ProcessHost,
  StopSignal,
} from "../../../starters/contract3/src/kernel/process-types.ts";
import { path } from "../../../starters/contract3/src/kernel/validation/brands.ts";
import { timerLimit, unchangedEffects } from "./oracle.ts";

type Recorded = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  // performance.now() at the write: the fake clock when timers are faked.
  readonly at: number;
};

export function recordingHost() {
  const writes: Recorded[] = [];
  const exits: number[] = [];
  let listener: ((signal: StopSignal) => void) | undefined;
  const decoder = new TextDecoder();
  const host: ProcessHost = {
    write(stream, bytes) {
      writes.push({
        stream,
        text: decoder.decode(bytes),
        at: performance.now(),
      });
      return Promise.resolve(true);
    },
    exit(code) {
      exits.push(code);
    },
    onSignal(next) {
      listener = next;
    },
    onCrash: () => undefined,
    now: () => performance.now(),
  };
  return {
    host,
    writes,
    exits,
    signal(name: StopSignal) {
      if (!listener)
        throw new Error("The front door installed no signal hook.");
      listener(name);
    },
  };
}

export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Event-loop turns. setImmediate is not faked by Bun's fake timers.
export async function turns(count = 20): Promise<void> {
  for (let index = 0; index < count; index++)
    await new Promise((done) => setImmediate(done));
}

// A real pause that fake timers cannot shorten: Bun fakes setTimeout,
// Bun.sleep, Date.now, performance.now and Bun.nanoseconds.
export function realPause(seconds: number): void {
  Bun.spawnSync(["/bin/sleep", String(seconds)]);
}

// Polls a real condition for about `seconds`, letting the loop turn.
export async function until(
  condition: () => boolean,
  seconds = 5,
): Promise<boolean> {
  for (let tries = 0; tries < seconds * 100; tries++) {
    if (condition()) return true;
    await turns(2);
    realPause(0.01);
  }
  return condition();
}

// Moves the fake clock forward one due timer at a time and lets the loop turn
// after each, so a timer armed by async work after a callback is armed at the
// fake time it would be armed in real life. A sentinel timer at the target
// (never above the runtime limit) stops each step from overshooting.
export async function advance(milliseconds: number): Promise<void> {
  const target = performance.now() + milliseconds;
  while (performance.now() < target) {
    const sentinel = setTimeout(
      () => undefined,
      Math.min(target - performance.now(), timerLimit),
    );
    jest.advanceTimersToNextTimer();
    clearTimeout(sentinel);
    await turns();
  }
}

// Processes whose argv carries `marker`, from the OS process table.
export function markedPids(marker: string): readonly number[] {
  const listed = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,args="]);
  return listed.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => Number(line.trim().split(" ")[0]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}
// Program children lead their own process group: kill the whole group.
export function killMarked(marker: string): void {
  for (const pid of markedPids(marker))
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
}

export function shell(
  script: string,
  overrides: Partial<Omit<ProgramRequest, "executable" | "args">> = {},
): ProgramRequest {
  return {
    executable: path("/bin/sh"),
    args: ["-c", script],
    timeoutMilliseconds: 30_000,
    outputLimitBytes: 4096,
    shutdownMilliseconds: 2_000,
    ...overrides,
  };
}

// One inspect command with deadline support and the programs capability.
// `work` is the handler body; the test controls when it returns.
export function holdContract(
  work: (programs: ProgramsCapability) => Promise<void>,
) {
  const hold = command({
    identity: "rc.hold",
    route: ["hold"],
    summary: "Hold until the test releases the handler.",
    input: {
      arguments: [],
      options: [],
      constraints: [],
      deadlineSupported: true,
      additionalArguments: false,
      additionalOptions: false,
    },
    capabilities: { programs: true },
    run: async (_input, context) => {
      await work(context.programs);
      return context.result(
        { commandIdentity: "rc.hold", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Released.", data: null, effects: unchangedEffects },
      );
    },
  });
  return contractFor({
    cli: "rc",
    commands: [hold],
    installedAddons: ["programs"],
  });
}

// Optional receipt line for observations that are recorded, not asserted.
export function note(entry: Record<string, unknown>): void {
  const target = process.env.T2_EVIDENCE;
  if (target) appendFileSync(target, `${JSON.stringify(entry)}\n`);
}
