import type { LogRecord } from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, redactByField } from "@logtape/redaction";
import type { DiagnosticsLevel } from "../../kernel/index.ts";
import { limits } from "./limits.ts";

const markers = {
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
type Walk = { readonly seen: Set<object>; visited: number };

function nullPrototypeRecord(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  Object.setPrototypeOf(result, null);
  return result;
}

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

function concealScalar(
  value: number | boolean | null,
  secretForms: readonly string[],
): number | boolean | null | string {
  const text = JSON.stringify(value);
  return secretForms.some((form) => text.includes(form))
    ? markers.redacted
    : value;
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

function boundedArray(
  value: readonly unknown[],
  secretForms: readonly string[],
  level: number,
  cut: Cut,
  walk: Walk,
): unknown[] {
  const items: unknown[] = [];
  const count = Math.min(value.length, limits.entries);
  for (let index = 0; index < count; index += 1) {
    if (walk.visited >= limits.traversalNodes) {
      items.push(lost(cut, markers.record));
      return items;
    }
    items.push(bounded(value[index], secretForms, level + 1, cut, walk));
  }
  if (value.length > limits.entries)
    items.push(
      lost(cut, `[truncated: ${value.length - limits.entries} more entries]`),
    );
  return items;
}

function boundedPlainObject(
  value: object,
  secretForms: readonly string[],
  level: number,
  cut: Cut,
  walk: Walk,
): Record<string, unknown> {
  const result = nullPrototypeRecord();
  const keys = Object.keys(value);
  const count = Math.min(keys.length, limits.entries);
  for (let index = 0; index < count; index += 1) {
    if (walk.visited >= limits.traversalNodes) {
      result["[truncated]"] = lost(cut, markers.record);
      return result;
    }
    const key = keys[index];
    if (key === undefined) continue;
    result[conceal(key, secretForms)] = bounded(
      Reflect.get(value, key),
      secretForms,
      level + 1,
      cut,
      walk,
    );
  }
  if (keys.length > limits.entries)
    result["[truncated]"] = lost(
      cut,
      `${keys.length - limits.entries} more keys`,
    );
  return result;
}

function boundedObject(
  value: unknown,
  secretForms: readonly string[],
  level: number,
  cut: Cut,
  walk: Walk,
): unknown {
  if (Array.isArray(value))
    return boundedArray(value, secretForms, level, cut, walk);
  if (typeof value !== "object" || value === null)
    return lost(cut, markers.unserialisable);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return lost(cut, markers.unserialisable);
  return boundedPlainObject(value, secretForms, level, cut, walk);
}

function boundedScalar(
  value: unknown,
  secretForms: readonly string[],
  cut: Cut,
): unknown {
  if (typeof value === "string") return boundedString(value, secretForms, cut);
  if (typeof value === "number" && !Number.isFinite(value))
    return lost(cut, markers.unserialisable);
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return concealScalar(value, secretForms);
  return lost(cut, markers.unserialisable);
}

function bounded(
  value: unknown,
  secretForms: readonly string[],
  level: number,
  cut: Cut,
  walk: Walk = { seen: new Set(), visited: 0 },
): unknown {
  if (walk.visited >= limits.traversalNodes) return lost(cut, markers.record);
  walk.visited += 1;
  if (typeof value !== "object" || value === null)
    return boundedScalar(value, secretForms, cut);
  if (walk.seen.has(value)) return lost(cut, markers.cycle);
  if (level >= limits.depth) return lost(cut, markers.depth);
  walk.seen.add(value);
  try {
    return boundedObject(value, secretForms, level, cut, walk);
  } finally {
    walk.seen.delete(value);
  }
}

export function boundedValue(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  return bounded(value, forms(secrets), 0, { truncated: false });
}

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

export type RunPipeline = (
  level: DiagnosticsLevel,
  properties: Readonly<Record<string, unknown>>,
) => void;

const unmapped = Object.freeze({});

// Platform: LogTape 2.4.2 reports a redaction limit only to its process-wide
// meta logger. It also replaces a message placeholder that names no property
// when, and only when, a limit was exceeded, so the run reads that replacement
// as its own report.
function exceededRedactionLimit(record: LogRecord): boolean {
  return !record.message.includes(unmapped);
}

function redactor(): (record: LogRecord) => LogRecord | undefined {
  let redacted: LogRecord | undefined;
  const redact = redactByField(
    (record: LogRecord) => {
      redacted = record;
    },
    {
      fieldPatterns: DEFAULT_REDACT_FIELDS,
      action: () => markers.redacted,
      maxDepth: limits.redactionDepth,
      maxProperties: limits.redactionEntries,
    },
  );
  return (record) => {
    redacted = undefined;
    try {
      redact(record);
    } catch {
      return undefined;
    }
    return redacted;
  };
}

export function pipelineFor(
  category: readonly string[],
  deliver: (record: LogRecord) => void,
  report: () => void,
): RunPipeline {
  const redact = redactor();
  return (level, properties) => {
    const redacted = redact({
      category,
      level,
      timestamp: Date.now(),
      rawMessage: "{event}{unmapped}",
      message: ["", properties["event"], "", unmapped, ""],
      properties: { ...properties },
    });
    if (!redacted) {
      report();
      return;
    }
    if (exceededRedactionLimit(redacted)) report();
    deliver(redacted);
  };
}
