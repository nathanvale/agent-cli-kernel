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

// LIFE-14 and DIAG-16: the comparable form of an envelope. Only the run
// identity and the diagnostics object are normalised; every domain, effect,
// guidance and recovery field is compared as emitted. The 3.0.0 wire has no
// other time field. Returns undefined for a value that is not an envelope.
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
