import { record } from "./validation/primitives.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function comparableEnvelope(envelope: unknown): string | undefined {
  if (!record(envelope) || !record(envelope.result)) return undefined;
  return JSON.stringify(
    canonical({
      ...envelope,
      result: { ...envelope.result, runId: "<run>" },
      ...(envelope.diagnostics === undefined
        ? {}
        : { diagnostics: "<diagnostics>" }),
    }),
  );
}
