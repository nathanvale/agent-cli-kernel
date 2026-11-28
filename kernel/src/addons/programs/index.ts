import type {
  AttachedAddon,
  ProgramRequest,
  ProgramResult,
  ProgramsCapability,
  RecordedEffect,
  RunAddon,
  RunControl,
} from "../../kernel/index.ts";
import { errorCode } from "../../shared/error-code.ts";
import { afterDelay } from "./timer.ts";

// Interface: CMD-14: a command that runs a caller-supplied program says so in its
// summary. `supplied` refuses to start a program for a command whose summary
// omits these words.
export const callerProgramDisclosure = "Runs a program supplied by the caller.";

export type ShutdownAttempt = {
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly afterMilliseconds: number;
};

// Interface: Evidence the kernel's ProgramResult cannot carry. Attempts are requests,
// never proof of termination. `groupEmpty` is the observed state of the owned
// process group only: a descendant that left the group is not observed.
export type ProgramDetails = {
  readonly pid: number;
  readonly timedOut: boolean;
  readonly signal: NodeJS.Signals | number | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly attempts: readonly ShutdownAttempt[];
  readonly groupEmpty: boolean;
};

const details = new WeakMap<object, ProgramDetails>();

export function programDetails(
  result: ProgramResult,
): ProgramDetails | undefined {
  return details.get(result);
}

// Interface: The most input a command may supply to one program. An engineering
// number with no contract source: room for a secret, a configuration document
// or a prompt, and small enough to copy once when the program starts.
const inputLimitBytes = 1_048_576;

const killObservationMilliseconds = 200;
const pollMilliseconds = 10;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const commandProblem =
  "A program needs an absolute executable path and string arguments.";

function requestProblem(request: ProgramRequest): string | undefined {
  if (
    typeof request.executable !== "string" ||
    !request.executable.startsWith("/") ||
    !Array.isArray(request.args) ||
    !request.args.every((arg) => typeof arg === "string")
  )
    return commandProblem;
  if (
    !positive(request.timeoutMilliseconds) ||
    !positive(request.outputLimitBytes) ||
    !positive(request.shutdownMilliseconds)
  )
    return "A program needs a positive timeout, output limit and shutdown budget.";
  return undefined;
}

// Platform: a Uint8Array's own `byteLength` can be shadowed, and instanceof passes
// for Object.create(Uint8Array.prototype). The typed-array prototype's getter
// reads the intrinsic length and throws for anything that is not a typed array.
const typedArrayPrototype: unknown = Object.getPrototypeOf(
  Uint8Array.prototype,
);
function intrinsicByteLength(input: Uint8Array): number | undefined {
  try {
    const length: unknown = Reflect.get(
      Object(typedArrayPrototype),
      "byteLength",
      input,
    );
    return typeof length === "number" ? length : undefined;
  } catch {
    return undefined;
  }
}

function inputProblem(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const length =
    input instanceof Uint8Array ? intrinsicByteLength(input) : undefined;
  if (length === undefined) return "A program's input must be a Uint8Array.";
  return length > inputLimitBytes
    ? `A program's input is at most ${String(inputLimitBytes)} bytes.`
    : undefined;
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: string[] = [];
  for (const item of Array.from(value, (entry: unknown) => entry)) {
    if (typeof item !== "string") return undefined;
    list.push(item);
  }
  return Object.freeze(list);
}

type CheckedRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly outputLimitBytes: number;
  readonly shutdownMilliseconds: number;
  readonly stdin: Uint8Array | "ignore";
};

// Interface: Reads each request field once into a frozen own copy, checks that
// copy, and copies the input's bytes, so nothing the caller changes later
// reaches the program. Throws the refusal before any program or admission.
function checkedRequest(request: ProgramRequest): CheckedRequest {
  const read = {
    executable: request.executable,
    args: request.args,
    timeoutMilliseconds: request.timeoutMilliseconds,
    outputLimitBytes: request.outputLimitBytes,
    shutdownMilliseconds: request.shutdownMilliseconds,
  };
  const args = stringList(read.args);
  const input: unknown = request.input;
  const problem =
    (args === undefined ? commandProblem : undefined) ??
    requestProblem({ ...read, args: args ?? [] }) ??
    inputProblem(input);
  if (problem) throw new Error(problem);
  return Object.freeze({
    ...read,
    args: args ?? [],
    stdin: input instanceof Uint8Array ? new Uint8Array(input) : "ignore",
  });
}

class OwnedGroup {
  readonly attempts: ShutdownAttempt[] = [];
  readonly pid: number;
  private empty = false;
  private readonly started: number;
  private readonly shutdownMilliseconds: number;
  constructor(pid: number, started: number, shutdownMilliseconds: number) {
    this.pid = pid;
    this.started = started;
    this.shutdownMilliseconds = shutdownMilliseconds;
  }

  gone(): boolean {
    if (this.empty) return true;
    try {
      process.kill(-this.pid, 0);
      return false;
    } catch (error) {
      this.empty = errorCode(error) === "ESRCH";
      return this.empty;
    }
  }

  send(signal: "SIGTERM" | "SIGKILL"): void {
    if (
      this.gone() ||
      this.attempts.some((attempt) => attempt.signal === signal)
    )
      return;
    this.attempts.push({
      signal,
      afterMilliseconds: Math.round(performance.now() - this.started),
    });
    try {
      process.kill(-this.pid, signal);
    } catch {
      return;
    }
  }

  async waitGone(milliseconds: number): Promise<boolean> {
    const until = performance.now() + milliseconds;
    while (!this.gone()) {
      if (performance.now() >= until) return false;
      await sleep(pollMilliseconds);
    }
    return true;
  }

  async stop(limit?: number): Promise<boolean> {
    if (this.gone()) return true;
    this.send("SIGTERM");
    const termAt =
      this.started +
      (this.attempts.find((attempt) => attempt.signal === "SIGTERM")
        ?.afterMilliseconds ?? 0);
    const budget = Math.min(this.shutdownMilliseconds, limit ?? Infinity);
    if (await this.waitGone(termAt + budget - performance.now())) return true;
    this.send("SIGKILL");
    return this.waitGone(killObservationMilliseconds);
  }
}

async function capture(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abandon: Promise<void>,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let abandoned = false;
  // Platform: Racing every read against a long-lived promise would retain each chunk
  // and grow memory with the child's output.
  void abandon.then(() => {
    abandoned = true;
    return reader.cancel().catch(() => undefined);
  });
  for (;;) {
    const next = await reader.read().catch(() => undefined);
    if (!next || next.done) {
      if (abandoned) truncated = true;
      break;
    }
    const room = limit - size;
    if (room > 0) {
      const part = next.value.slice(0, room);
      kept.push(part);
      size += part.byteLength;
    }
    if (next.value.byteLength > room) truncated = true;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function attachPrograms(run: RunControl): AttachedAddon<ProgramsCapability> {
  const owned = new Set<OwnedGroup>();

  function start(request: ProgramRequest): Promise<ProgramResult> {
    try {
      return launch(checkedRequest(request));
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Invalid program request."),
      );
    }
  }

  async function launch(request: CheckedRequest): Promise<ProgramResult> {
    if (run.signal.aborted)
      throw new Error("The run is stopping; no new program starts.");
    const started = performance.now();
    const child = Bun.spawn([request.executable, ...request.args], {
      detached: true,
      stdin: request.stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
    const group = new OwnedGroup(
      child.pid,
      started,
      request.shutdownMilliseconds,
    );
    owned.add(group);
    let release = () => undefined;
    const abandon = new Promise<void>((resolve) => {
      release = () => {
        resolve();
        return undefined;
      };
    });
    const output = Promise.all([
      capture(child.stdout, request.outputLimitBytes, abandon),
      capture(child.stderr, request.outputLimitBytes, abandon),
    ]);
    let timedOut = false;
    const cancelTimeout = afterDelay(request.timeoutMilliseconds, () => {
      timedOut = true;
      void group.stop();
    });
    await child.exited;
    cancelTimeout();
    const groupEmpty = await group.stop();
    const cancelDrain = afterDelay(request.shutdownMilliseconds, release);
    const [stdout, stderr] = await output;
    cancelDrain();
    if (groupEmpty) owned.delete(group);
    const result: ProgramResult = Object.freeze({
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: child.exitCode,
      terminationConfirmed: groupEmpty,
      outputTruncated: stdout.truncated || stderr.truncated,
    });
    details.set(
      result,
      Object.freeze({
        pid: child.pid,
        timedOut,
        signal: child.signalCode,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        attempts: Object.freeze([...group.attempts]),
        groupEmpty,
      }),
    );
    return result;
  }

  const capability: ProgramsCapability = Object.freeze({
    inspect: start,
    supplied(request: ProgramRequest) {
      return run.summary.includes(callerProgramDisclosure)
        ? start(request)
        : Promise.reject(
            new Error("The command summary does not disclose caller programs."),
          );
    },
    domain<Effect extends string>(effect: RecordedEffect<Effect>) {
      return Object.freeze({
        effect: effect.effect,
        start(request: ProgramRequest) {
          if (effect.runId !== run.runId)
            return Promise.reject(
              new Error("The recorded effect belongs to another run."),
            );
          let checked: CheckedRequest;
          try {
            checked = checkedRequest(request);
          } catch (error) {
            return Promise.reject(
              error instanceof Error
                ? error
                : new Error("Invalid program request."),
            );
          }
          return effect.admitStart(run.runId, effect.effect, () =>
            launch(checked),
          );
        },
      });
    },
  });

  return {
    capability,
    async settle(limit?: number) {
      const groups = [...owned];
      const stopped = await Promise.all(
        groups.map((group) => group.stop(limit)),
      );
      groups.forEach((group, index) => {
        if (stopped[index]) owned.delete(group);
      });
      return stopped.every(Boolean);
    },
    killNow() {
      for (const group of owned) group.send("SIGKILL");
    },
  };
}

export function programsAddon(): RunAddon<ProgramsCapability> {
  return { attach: attachPrograms };
}
