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
  const comparable = {
    ...envelope,
    result: { ...envelope.result, runId: "<run>" },
  };
  return JSON.stringify(
    canonical(
      envelope.diagnostics === undefined
        ? comparable
        : { ...comparable, diagnostics: "<diagnostics>" },
    ),
  );
}
