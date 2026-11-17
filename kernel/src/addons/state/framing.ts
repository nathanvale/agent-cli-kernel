import { createHash } from "node:crypto";

const magic = "C3S1";
const kindPattern = "[a-z-]{1,24}";
const kindMaxLength = 24;
const lengthDigits = 10;
const checksumDigits = 64;
const headerBytes =
  magic.length + 1 + kindMaxLength + 1 + lengthDigits + 1 + checksumDigits + 1;
const headerSource = `${magic} (${kindPattern}) (\\d{${lengthDigits}}) ([0-9a-f]{${checksumDigits}})`;
const headerPattern = new RegExp(`^${headerSource}$`);
const recordStart = new RegExp(`(^|\\n)${headerSource}\\n`);
const kindOnly = new RegExp(`^${kindPattern}$`);
export const maxPayloadBytes = 65_536;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function checksum(kind: string, payload: Uint8Array): string {
  return createHash("sha256").update(`${kind}\n`).update(payload).digest("hex");
}

export function encodeRecord(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  if (!kindOnly.test(kind)) throw new Error("Invalid record kind.");
  const body = encoder.encode(JSON.stringify({ ...payload, format: 1, kind }));
  if (body.byteLength > maxPayloadBytes)
    throw new Error("Record payload exceeds its bound.");
  const header = `${magic} ${kind} ${String(body.byteLength).padStart(lengthDigits, "0")} ${checksum(kind, body)}\n`;
  const out = new Uint8Array(header.length + body.byteLength + 1);
  out.set(encoder.encode(header), 0);
  out.set(body, header.length);
  out[out.length - 1] = 10;
  return out;
}

export type ParsedRecord = {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
};
export type ParsedFile =
  | {
      readonly ok: true;
      readonly records: readonly ParsedRecord[];
      readonly tornTail: boolean;
    }
  | { readonly ok: false };

function readOne(
  bytes: Uint8Array,
  offset: number,
):
  | {
      readonly kind: "record";
      readonly record: ParsedRecord;
      readonly end: number;
    }
  | { readonly kind: "short" | "invalid" } {
  const newline = bytes.indexOf(10, offset);
  if (newline === -1)
    return bytes.byteLength - offset < headerBytes
      ? { kind: "short" }
      : { kind: "invalid" };
  let header: string;
  try {
    header = decoder.decode(bytes.subarray(offset, newline));
  } catch {
    return { kind: "invalid" };
  }
  const match = headerPattern.exec(header);
  if (!match?.[1] || !match[2] || !match[3]) return { kind: "invalid" };
  const kind = match[1];
  const length = Number(match[2]);
  if (length > maxPayloadBytes) return { kind: "invalid" };
  const start = newline + 1;
  const end = start + length;
  if (end + 1 > bytes.byteLength) return { kind: "short" };
  if (bytes[end] !== 10) return { kind: "invalid" };
  const body = bytes.subarray(start, end);
  if (checksum(kind, body) !== match[3]) return { kind: "invalid" };
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(body));
  } catch {
    return { kind: "invalid" };
  }
  const object = plainObject(payload);
  if (!object || object.kind !== kind || object.format !== 1)
    return { kind: "invalid" };
  return { kind: "record", record: { kind, payload: object }, end: end + 1 };
}

export function parseRecords(bytes: Uint8Array): ParsedFile {
  const records: ParsedRecord[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const next = readOne(bytes, offset);
    if (next.kind === "record") {
      records.push(next.record);
      offset = next.end;
      continue;
    }
    const newline = bytes.indexOf(10, offset);
    const afterHeader = newline === -1 ? bytes.byteLength : newline + 1;
    const rest = bytes.subarray(afterHeader);
    return containsRecordStart(rest)
      ? { ok: false }
      : { ok: true, records, tornTail: true };
  }
  return { ok: true, records, tornTail: false };
}

function containsRecordStart(bytes: Uint8Array): boolean {
  return recordStart.test(new TextDecoder().decode(bytes));
}

export function plainObject(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}
