import type { MenuResult, MenuRow } from "../../kernel/index.ts";

export type MenuKey =
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  | { readonly kind: "enter" }
  | { readonly kind: "cancel" }
  | { readonly kind: "interrupt" }
  | { readonly kind: "backspace" }
  | { readonly kind: "text"; readonly value: string };

export type MenuStepResult<Value> =
  | MenuResult<Value>
  | { readonly kind: "interrupt" };

export type IndexedRow<Value> = {
  readonly index: number;
  readonly label: string;
  readonly lowerLabel: string;
  readonly value: Value;
};

export type MenuState<Value> = {
  readonly lines: readonly string[];
  readonly rows: readonly IndexedRow<Value>[];
  readonly filter: string;
  readonly matches: readonly IndexedRow<Value>[];
  readonly cursor: number;
  readonly offset: number;
};

const maxFilterLength = 200;

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const blockedCodeRanges: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

function isControlOrBidi(code: number): boolean {
  return blockedCodeRanges.some(([low, high]) => code >= low && code <= high);
}

function skipCsi(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function skipOsc(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

function skipEscapeAt(text: string, index: number): number | undefined {
  const code = text.charCodeAt(index);
  if (code === 0x9b) return skipCsi(text, index + 1);
  if (code === 0x9d) return skipOsc(text, index + 1);
  if (code !== 0x1b) return undefined;
  const next = text.charCodeAt(index + 1);
  if (next === 0x5b) return skipCsi(text, index + 2);
  if (next === 0x5d) return skipOsc(text, index + 2);
  return index + 1;
}

export function sanitizeText(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const skipped = skipEscapeAt(text, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const point = text.codePointAt(index);
    if (point === undefined) break;
    const step = point > 0xffff ? 2 : 1;
    if (!isControlOrBidi(point)) out += text.slice(index, index + step);
    index += step;
  }
  return out;
}

export function clipToWidth(text: string, columns: number): string {
  const limit = Math.max(1, Math.floor(columns));
  let count = 0;
  let out = "";
  for (const ch of text) {
    if (count >= limit) break;
    out += ch;
    count += 1;
  }
  return out;
}

const decoder = new TextDecoder();

type ParsedKey = { readonly next: number; readonly key?: MenuKey };

const arrowKeys = new Map<number, MenuKey>([
  [0x41, { kind: "up" }],
  [0x42, { kind: "down" }],
]);

const controlKeys = new Map<number, MenuKey>([
  [0x03, { kind: "interrupt" }],
  [0x08, { kind: "backspace" }],
  [0x0a, { kind: "enter" }],
  [0x0d, { kind: "enter" }],
  [0x0e, { kind: "down" }],
  [0x10, { kind: "up" }],
  [0x7f, { kind: "backspace" }],
]);

function parseCsiKey(bytes: Uint8Array, start: number): ParsedKey {
  let index = start + 2;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === undefined) break;
    index += 1;
    if (byte >= 0x40 && byte <= 0x7e) {
      const key = index === start + 3 ? arrowKeys.get(byte) : undefined;
      return key ? { next: index, key } : { next: index };
    }
  }
  return { next: index };
}

function parseSs3Key(bytes: Uint8Array, start: number): ParsedKey {
  const final = bytes[start + 2];
  const key = final === undefined ? undefined : arrowKeys.get(final);
  return key
    ? { next: start + 3, key }
    : { next: Math.min(bytes.length, start + 3) };
}

function parseEscapeSequence(bytes: Uint8Array, start: number): ParsedKey {
  const after = bytes[start + 1];
  if (after === undefined) return { next: start + 1, key: { kind: "cancel" } };
  if (after === 0x5b) return parseCsiKey(bytes, start);
  if (after === 0x4f) return parseSs3Key(bytes, start);
  return { next: Math.min(bytes.length, start + 2) };
}

function parseTextSpan(bytes: Uint8Array, start: number): ParsedKey {
  let end = start + 1;
  while (end < bytes.length) {
    const nextByte = bytes[end];
    if (nextByte === undefined || nextByte < 0x20 || nextByte === 0x7f) break;
    end += 1;
  }
  const clean = sanitizeText(decoder.decode(bytes.subarray(start, end)));
  return clean.length > 0
    ? { next: end, key: { kind: "text", value: clean } }
    : { next: end };
}

function parseNextKey(bytes: Uint8Array, index: number): ParsedKey {
  const byte = bytes[index];
  if (byte === undefined) return { next: bytes.length };
  const mapped = controlKeys.get(byte);
  if (mapped) return { next: index + 1, key: mapped };
  if (byte === 0x1b) return parseEscapeSequence(bytes, index);
  if (byte < 0x20) return { next: index + 1 };
  return parseTextSpan(bytes, index);
}

export function parseKeyBytes(bytes: Uint8Array): readonly MenuKey[] {
  const keys: MenuKey[] = [];
  let index = 0;
  while (index < bytes.length) {
    const parsed = parseNextKey(bytes, index);
    if (parsed.key) keys.push(parsed.key);
    index = parsed.next;
  }
  return keys;
}

export function createMenuState<Value>(
  lines: readonly string[],
  rows: readonly MenuRow<Value>[],
): MenuState<Value> {
  const indexed: readonly IndexedRow<Value>[] = rows.map((row, index) => {
    const label = sanitizeText(row.label);
    return {
      index,
      label,
      lowerLabel: label.toLowerCase(),
      value: row.value,
    };
  });
  return {
    lines: lines.map((line) => sanitizeText(line)),
    rows: indexed,
    filter: "",
    matches: indexed,
    cursor: 0,
    offset: 0,
  };
}

function withFilter<Value>(
  state: MenuState<Value>,
  filter: string,
): MenuState<Value> {
  const trimmed = clipToWidth(filter, maxFilterLength);
  const needle = trimmed.toLowerCase();
  const matches =
    needle === ""
      ? state.rows
      : state.rows.filter((row) => row.lowerLabel.includes(needle));
  return {
    ...state,
    filter: trimmed,
    matches,
    cursor: 0,
    offset: 0,
  };
}

export function stepMenu<Value>(
  state: MenuState<Value>,
  key: MenuKey,
): {
  readonly state: MenuState<Value>;
  readonly result?: MenuStepResult<Value>;
} {
  switch (key.kind) {
    case "up": {
      if (state.matches.length === 0) return { state };
      const cursor = Math.max(0, state.cursor - 1);
      return { state: { ...state, cursor } };
    }
    case "down": {
      if (state.matches.length === 0) return { state };
      const cursor = Math.min(state.matches.length - 1, state.cursor + 1);
      return { state: { ...state, cursor } };
    }
    case "enter": {
      const chosen = state.matches[state.cursor];
      if (!chosen) return { state };
      return {
        state,
        result: {
          kind: "picked",
          value: chosen.value,
          index: chosen.index,
        },
      };
    }
    case "cancel":
      return { state, result: { kind: "cancelled" } };
    case "interrupt":
      return { state, result: { kind: "interrupt" } };
    case "backspace": {
      const points = [...state.filter];
      if (points.length === 0) return { state };
      return { state: withFilter(state, points.slice(0, -1).join("")) };
    }
    case "text":
      return { state: withFilter(state, state.filter + key.value) };
  }
}

export function renderMenu<Value>(
  state: MenuState<Value>,
  size: { readonly columns: number; readonly rows: number },
): readonly string[] {
  const columns = Math.max(1, Math.floor(size.columns));
  const height = Math.max(1, Math.floor(size.rows));
  const header = state.lines.map((line) => clipToWidth(line, columns));
  const filterLine = clipToWidth(`Filter: ${state.filter}`, columns);
  const visibleRows = Math.max(1, height - header.length - 1);
  const body: string[] = [];
  if (state.matches.length === 0) {
    body.push(clipToWidth("  (no matches)", columns));
  } else {
    let start = state.offset;
    if (state.cursor < start) start = state.cursor;
    if (state.cursor >= start + visibleRows)
      start = state.cursor - visibleRows + 1;
    const end = Math.min(state.matches.length, start + visibleRows);
    for (let index = start; index < end; index += 1) {
      const row = state.matches[index];
      if (!row) continue;
      const prefix = index === state.cursor ? "> " : "  ";
      body.push(clipToWidth(`${prefix}${row.label}`, columns));
    }
  }
  return [...header, filterLine, ...body].slice(0, height);
}
