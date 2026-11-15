import { fallbackMessage, fallbackText } from "./fallback.ts";
import type { TrustedRun } from "./fallback.ts";
import { oneLine, renderHuman } from "./human.ts";
import type { ProcessHost } from "./process-types.ts";
import type { ContractRuntime } from "./runtime.ts";
import type { Envelope, Validation } from "./types.ts";
import { json } from "./validation/primitives.ts";

export type Writer = {
  // Serialises one result for this run (LIFE-7). Resolves the process exit
  // that agrees with what was emitted, or undefined when a stop request
  // forbids starting any envelope; the stop path then owns termination.
  readonly emit: (
    candidate: Validation<unknown>,
    trusted: TrustedRun,
  ) => Promise<number | undefined>;
};

const encoder = new TextEncoder();

// One writer per run. It never throws, never writes a second envelope and
// never writes to stderr in machine mode.
export function createWriter(options: {
  readonly host: ProcessHost;
  readonly runtime: ContractRuntime;
  readonly machine: boolean;
  readonly stopping: () => boolean;
}): Writer {
  const { host, runtime, machine, stopping } = options;
  let used = false;

  // Steps 2 and 3: the plain-JSON guard before any serialisation, then strict
  // validation of exactly the bytes that will be written.
  async function admit(value: unknown, trusted: TrustedRun) {
    if (!json(value)) return undefined;
    const text = JSON.stringify(value);
    const checked = await runtime.validate(JSON.parse(text));
    if (
      !checked.ok ||
      checked.value.result.runId !== trusted.runId ||
      checked.value.result.commandIdentity !== trusted.commandIdentity
    )
      return undefined;
    return { text, envelope: checked.value };
  }

  function output(text: string, envelope: Envelope) {
    if (machine) return { stream: "stdout", text: `${text}\n` } as const;
    return renderHuman(runtime.cli, envelope);
  }

  async function write(stream: "stdout" | "stderr", text: string) {
    if (stopping()) return undefined;
    return host.write(stream, encoder.encode(text));
  }

  return {
    async emit(candidate, trusted) {
      if (used || stopping()) return undefined;
      used = true;
      try {
        const admitted = candidate.ok
          ? await admit(candidate.value, trusted)
          : undefined;
        if (admitted) {
          const target = output(admitted.text, admitted.envelope);
          const drained = await write(target.stream, target.text);
          if (drained === undefined) return undefined;
          return drained ? admitted.envelope.result.exitCode : 1;
        }
        // LIFE-9: exactly one fallback attempt, only before any stdout write.
        const fallback = await fallbackText(runtime, trusted);
        if (fallback === undefined) return 1;
        const target = machine
          ? ({ stream: "stdout", text: `${fallback}\n` } as const)
          : ({
              stream: "stderr",
              text: `${oneLine(runtime.cli)}: ${fallbackMessage}\n`,
            } as const);
        const drained = await write(target.stream, target.text);
        return drained === undefined ? undefined : 1;
      } catch {
        return 1;
      }
    },
  };
}
