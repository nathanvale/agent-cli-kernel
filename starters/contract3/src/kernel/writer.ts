import {
  fallbackMessage,
  fallbackText,
  unavailableStatus,
} from "./fallback.ts";
import type { TrustedRun } from "./fallback.ts";
import { oneLine, renderHuman } from "./human.ts";
import type { ProcessHost } from "./process-types.ts";
import type { ContractRuntime } from "./runtime.ts";
import type { Diagnostics, Envelope, Validation } from "./types.ts";
import { diagnostics } from "./validation/diagnostics.ts";
import { json, record } from "./validation/primitives.ts";

// A status report from the status seam: present only when a status is due.
// `value` is untrusted.
export type StatusReport = { readonly value: unknown };

export type Writer = {
  // Serialises one result for this run (LIFE-7). Resolves the process exit
  // that agrees with what was emitted, or undefined when a stop request
  // forbids starting any envelope; the stop path then owns termination.
  readonly emit: (
    candidate: Validation<unknown>,
    trusted: TrustedRun,
    report?: StatusReport,
  ) => Promise<number | undefined>;
};

// LIFE-7 step 1 and DIAG-4: the diagnostics object is validated on its own,
// on a plain-JSON copy, after the domain result is frozen. An invalid one
// becomes the unavailable variant; this step never takes the fallback.
function frozenDiagnostics(report: StatusReport): Diagnostics {
  try {
    const copy: unknown = json(report.value)
      ? JSON.parse(JSON.stringify(report.value))
      : undefined;
    if (diagnostics(copy)) return copy;
  } catch {
    // An unreadable status is an invalid one.
  }
  return unavailableStatus("status-invalid");
}

// The frozen status joins the frozen candidate as the top-level key.
function withStatus(
  candidate: Validation<unknown>,
  status: Diagnostics | undefined,
): Validation<unknown> {
  if (!status || !candidate.ok || !record(candidate.value)) return candidate;
  return { ok: true, value: { ...candidate.value, diagnostics: status } };
}

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
  async function validateForWrite(value: unknown, trusted: TrustedRun) {
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

  // Pre-write validation never throws: any fault before a write is a writer failure,
  // which takes LIFE-9's single fallback attempt.
  async function validateCandidateForWrite(
    candidate: Validation<unknown>,
    trusted: TrustedRun,
  ) {
    if (!candidate.ok) return undefined;
    try {
      const value = await validateForWrite(candidate.value, trusted);
      return value
        ? { ...value, target: output(value.text, value.envelope) }
        : undefined;
    } catch {
      return undefined;
    }
  }

  // LIFE-9: exactly one fallback attempt, only before any stdout write. Any
  // construction, validation, encoding or write failure ends with exit 1.
  async function fallback(trusted: TrustedRun) {
    try {
      const text = await fallbackText(runtime, trusted);
      if (text === undefined) return 1;
      const drained = machine
        ? await write("stdout", `${text}\n`)
        : await write(
            "stderr",
            `${oneLine(runtime.cli)}: ${fallbackMessage}\n`,
          );
      return drained === undefined ? undefined : 1;
    } catch {
      return 1;
    }
  }

  return {
    async emit(candidate, trusted, report) {
      if (used || stopping()) return undefined;
      used = true;
      const status = report ? frozenDiagnostics(report) : undefined;
      const run = status ? { ...trusted, diagnostics: status } : trusted;
      const ready = await validateCandidateForWrite(
        withStatus(candidate, status),
        run,
      );
      if (!ready) return fallback(run);
      const drained = await write(ready.target.stream, ready.target.text).catch(
        () => false,
      );
      if (drained === undefined) return undefined;
      return drained ? ready.envelope.result.exitCode : 1;
    },
  };
}
