import type { LogRecord } from "@logtape/logtape";
import { limits } from "./limits.ts";

export const markers = {
  redacted: "[REDACTED]",
  depth: "[truncated: depth]",
  cycle: "[truncated: cycle]",
  unserialisable: "[unserialisable]",
  record: `[truncated: record exceeded ${limits.recordBytes} bytes]`,
} as const;

const encoder = new TextEncoder();

export type Line = {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
};
type Cut = { truncated: boolean };

// Exact secret values and their JSON-escaped forms, longest first so a secret
// that contains another is replaced whole.
function forms(secrets: readonly string[]): readonly string[] {
  const all = new Set<string>();
  for (const secret of secrets)
    if (secret.length > 0) {
      all.add(secret);
      all.add(JSON.stringify(secret).slice(1, -1));
    }
  return [...all].sort((a, b) => b.length - a.length);
}

function conceal(text: string, secretForms: readonly string[]): string {
  let result = text;
  for (const form of secretForms)
    result = result.split(form).join(markers.redacted);
  return result;
}

// A number, boolean or null whose JSON text holds a declared secret (the
// secret "4" recorded as 4, or inside 1431; "true" recorded as true) is
// replaced whole by the marker string, so the line stays valid JSON. As with
// strings, any occurrence counts, so a short secret also hides unrelated
// values that contain it.
function concealScalar(
  value: number | boolean | null,
  secretForms: readonly string[],
): number | boolean | null | string {
  const text = JSON.stringify(value);
  return secretForms.some((form) => text.includes(form))
    ? markers.redacted
    : value;
}

function plain(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function lost(cut: Cut, marker: string): string {
  cut.truncated = true;
  return marker;
}

function boundedString(
  value: string,
  secretForms: readonly string[],
  cut: Cut,
): string {
  const text = conceal(value, secretForms);
  if (text.length <= limits.recordBytes) return text;
  return `${text.slice(0, limits.recordBytes)}${lost(cut, markers.record)}`;
}

function boundedObject(
  value: object,
  secretForms: readonly string[],
  level: number,
  cut: Cut,
  seen: Set<object>,
): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value
      .slice(0, limits.entries)
      .map((item: unknown) => bounded(item, secretForms, level + 1, cut, seen));
    if (value.length > limits.entries)
      items.push(
        lost(cut, `[truncated: ${value.length - limits.entries} more entries]`),
      );
    return items;
  }
  if (!plain(value)) return lost(cut, markers.unserialisable);
  const result: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, limits.entries))
    result[conceal(key, secretForms)] = bounded(
      Reflect.get(value, key),
      secretForms,
      level + 1,
      cut,
      seen,
    );
  if (keys.length > limits.entries)
    result["[truncated]"] = lost(
      cut,
      `${keys.length - limits.entries} more keys`,
    );
  return result;
}

// Plain JSON with every string concealed before it can be cut, a depth and
// entry bound, and a visible marker for whatever was not kept.
function bounded(
  value: unknown,
  secretForms: readonly string[],
  level: number,
  cut: Cut,
  seen: Set<object> = new Set(),
): unknown {
  if (typeof value === "number" && !Number.isFinite(value))
    return lost(cut, markers.unserialisable);
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return concealScalar(value, secretForms);
  if (typeof value === "string") return boundedString(value, secretForms, cut);
  if (typeof value !== "object") return lost(cut, markers.unserialisable);
  if (seen.has(value)) return lost(cut, markers.cycle);
  if (level >= limits.depth) return lost(cut, markers.depth);
  seen.add(value);
  try {
    return boundedObject(value, secretForms, level, cut, seen);
  } finally {
    seen.delete(value);
  }
}

// The header holds only values the add-on itself supplies (time, sequence,
// the kernel's run and command identities, elapsed time, level), so it is
// never concealed: a short secret can never rewrite a number or an identity
// and break the line.
function header(record: LogRecord, cut: Cut) {
  const properties = record.properties;
  return {
    time: new Date(record.timestamp).toISOString(),
    seq: bounded(properties.seq, [], 0, cut),
    runId: bounded(properties.runId, [], 0, cut),
    command: bounded(properties.commandIdentity, [], 0, cut),
    elapsedMilliseconds: bounded(properties.elapsedMilliseconds, [], 0, cut),
    level: record.level,
  };
}

function size(text: string): number {
  return encoder.encode(text).length + 1;
}

// A record above the bound keeps a visible marker and as much of its
// (already redacted) text as fits, still as one valid JSON line. If even an
// empty prefix does not fit, the marker-only line is returned.
function shortened(text: string, record: LogRecord): string {
  const cut: Cut = { truncated: true };
  for (
    let keep = limits.recordBytes - limits.shortenedReserveBytes;
    keep > 0;
    keep = Math.floor(keep * limits.shortenedKeepRatio)
  ) {
    const candidate = JSON.stringify({
      ...header(record, cut),
      truncated: markers.record,
      retainedPrefix: text.slice(0, keep),
    });
    if (size(candidate) <= limits.recordBytes) return candidate;
  }
  return JSON.stringify({ truncated: markers.record });
}

// One bounded, redacted line per record. Every string and key of the event
// and facts is concealed before any cut, so a cut can never expose part of a
// declared secret, and the line stays valid JSON.
export function lineMaker(
  secrets: readonly string[],
): (record: LogRecord) => Line {
  const secretForms = forms(secrets);
  return (record) => {
    const cut: Cut = { truncated: false };
    const text = JSON.stringify({
      ...header(record, cut),
      event: bounded(record.properties.event, secretForms, 0, cut),
      facts: bounded(record.properties.facts, secretForms, 0, cut),
    });
    if (size(text) <= limits.recordBytes)
      return { bytes: encoder.encode(`${text}\n`), truncated: cut.truncated };
    return {
      bytes: encoder.encode(`${shortened(text, record)}\n`),
      truncated: true,
    };
  };
}
