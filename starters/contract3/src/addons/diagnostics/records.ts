import type { LogRecord, TextFormatter } from "@logtape/logtape";
import { redactByPattern } from "@logtape/redaction";
import type { RedactionPattern } from "@logtape/redaction";

// DIAG-9 record bound and DIAG-12 visible truncation. Each record is one JSON
// line; the bound covers the line and its newline.
export const recordLimits = {
  recordBytes: 64_000,
  depth: 16,
  entries: 1_000,
} as const;

export const markers = {
  redacted: "[REDACTED]",
  depth: "[truncated: depth]",
  cycle: "[truncated: cycle]",
  unserialisable: "[unserialisable]",
  record: `[truncated: record exceeded ${recordLimits.recordBytes} bytes]`,
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

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function conceal(text: string, secretForms: readonly string[]): string {
  let result = text;
  for (const form of secretForms)
    result = result.split(form).join(markers.redacted);
  return result;
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
  if (text.length <= recordLimits.recordBytes) return text;
  return `${text.slice(0, recordLimits.recordBytes)}${lost(cut, markers.record)}`;
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
      .slice(0, recordLimits.entries)
      .map((item: unknown) => bounded(item, secretForms, level + 1, cut, seen));
    if (value.length > recordLimits.entries)
      items.push(
        lost(
          cut,
          `[truncated: ${value.length - recordLimits.entries} more entries]`,
        ),
      );
    return items;
  }
  if (!plain(value)) return lost(cut, markers.unserialisable);
  const result: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, recordLimits.entries))
    result[conceal(key, secretForms)] = bounded(
      Reflect.get(value, key),
      secretForms,
      level + 1,
      cut,
      seen,
    );
  if (keys.length > recordLimits.entries)
    result["[truncated]"] = lost(
      cut,
      `${keys.length - recordLimits.entries} more keys`,
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
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : lost(cut, markers.unserialisable);
  if (typeof value === "string") return boundedString(value, secretForms, cut);
  if (typeof value !== "object") return lost(cut, markers.unserialisable);
  if (seen.has(value)) return lost(cut, markers.cycle);
  if (level >= recordLimits.depth) return lost(cut, markers.depth);
  seen.add(value);
  try {
    return boundedObject(value, secretForms, level, cut, seen);
  } finally {
    seen.delete(value);
  }
}

function header(record: LogRecord, secretForms: readonly string[], cut: Cut) {
  const properties = record.properties;
  return {
    time: new Date(record.timestamp).toISOString(),
    seq: bounded(properties.seq, secretForms, 0, cut),
    runId: bounded(properties.runId, secretForms, 0, cut),
    command: bounded(properties.commandIdentity, secretForms, 0, cut),
    elapsedMilliseconds: bounded(
      properties.elapsedMilliseconds,
      secretForms,
      0,
      cut,
    ),
    level: record.level,
  };
}

function size(text: string): number {
  return encoder.encode(text).length + 1;
}

// A record above the bound keeps a visible marker and as much of its
// (already redacted) text as fits, still as one valid JSON line.
function shortened(
  text: string,
  record: LogRecord,
  secretForms: readonly string[],
): string {
  let keep = recordLimits.recordBytes - 2_048;
  for (;;) {
    const candidate = JSON.stringify({
      ...header(record, secretForms, { truncated: true }),
      truncated: markers.record,
      retainedPrefix: text.slice(0, Math.max(0, keep)),
    });
    if (size(candidate) <= recordLimits.recordBytes) return candidate;
    keep = Math.floor(keep * 0.8);
  }
}

// One bounded, redacted line per record. Every string is concealed before any
// cut; the pinned LogTape pattern redaction then runs over the finished line as
// a second pass.
export function lineMaker(
  secrets: readonly string[],
): (record: LogRecord) => Line {
  const secretForms = forms(secrets);
  const patterns: RedactionPattern[] = secretForms.map((form) => ({
    pattern: new RegExp(escaped(form), "g"),
    replacement: markers.redacted,
  }));
  let cut: Cut = { truncated: false };
  const line: TextFormatter = (record) =>
    JSON.stringify({
      ...header(record, secretForms, cut),
      event: bounded(record.properties.event, secretForms, 0, cut),
      facts: bounded(record.properties.facts, secretForms, 0, cut),
    });
  const redacted = patterns.length > 0 ? redactByPattern(line, patterns) : line;
  return (record) => {
    cut = { truncated: false };
    const text = redacted(record);
    if (size(text) <= recordLimits.recordBytes)
      return { bytes: encoder.encode(`${text}\n`), truncated: cut.truncated };
    return {
      bytes: encoder.encode(`${shortened(text, record, secretForms)}\n`),
      truncated: true,
    };
  };
}
