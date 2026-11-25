import { fallbackText, unavailableStatus } from "./fallback.ts";
import type { TrustedRun } from "./fallback.ts";
import { renderHuman } from "./human.ts";
import type { HumanWrite } from "./human.ts";
import type { ProcessHost } from "./process-types.ts";
import type { RenamedRoute } from "./routing.ts";
import type { ContractRuntime } from "./runtime.ts";
import type { Diagnostics, Envelope, Validation } from "./types.ts";
import { diagnostics } from "./validation/diagnostics.ts";
import { json, record } from "./validation/primitives.ts";

export type StatusReport = { readonly value: unknown };

export type Writer = {
  readonly emit: (
    candidate: Validation<unknown>,
    trusted: TrustedRun,
    report?: StatusReport,
  ) => Promise<number | undefined>;
};

function frozenDiagnostics(report: StatusReport): Diagnostics {
  const copy = jsonCopy(report.value);
  return diagnostics(copy) ? copy : unavailableStatus("status-invalid");
}

function jsonCopy(value: unknown): unknown {
  try {
    return json(value) ? JSON.parse(JSON.stringify(value)) : undefined;
  } catch {
    return undefined;
  }
}

function withStatus(
  candidate: Validation<unknown>,
  status: Diagnostics | undefined,
): Validation<unknown> {
  if (!status || !candidate.ok || !record(candidate.value)) return candidate;
  return { ok: true, value: { ...candidate.value, diagnostics: status } };
}

const encoder = new TextEncoder();

export function createWriter(options: {
  readonly host: ProcessHost;
  readonly runtime: ContractRuntime;
  readonly machine: boolean;
  readonly renamedHelp?: boolean;
  readonly renamedRoute?: RenamedRoute;
  readonly stopping: () => boolean;
}): Writer {
  const { host, runtime, machine, renamedHelp, renamedRoute, stopping } =
    options;
  let used = false;

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

  function output(text: string, envelope: Envelope): readonly HumanWrite[] {
    if (machine) return [{ stream: "stdout", text: `${text}\n` }];
    const humanOptions =
      renamedHelp === true || renamedRoute !== undefined
        ? {
            ...(renamedHelp === true ? { renamedHelp: true } : {}),
            ...(renamedRoute === undefined ? {} : { renamedRoute }),
          }
        : undefined;
    return renderHuman(runtime.cli, envelope, humanOptions);
  }

  async function write(stream: "stdout" | "stderr", text: string) {
    if (stopping()) return undefined;
    return host.write(stream, encoder.encode(text));
  }

  async function writeAll(writes: readonly HumanWrite[]) {
    for (const item of writes) {
      const drained = await write(item.stream, item.text).catch(() => false);
      if (drained !== true) return drained;
    }
    return true;
  }

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

  async function fallback(trusted: TrustedRun) {
    try {
      const ready = await fallbackText(runtime, trusted);
      if (ready === undefined) return 1;
      const drained = await writeAll(output(ready.text, ready.envelope));
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
      const drained = await writeAll(ready.target);
      if (drained === undefined) return undefined;
      return drained ? ready.envelope.result.exitCode : 1;
    },
  };
}
