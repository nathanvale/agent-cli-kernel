import { describe, expect, test } from "bun:test";
import type { MenuRow } from "../../../kernel/src/addons/menu/index.ts";
import {
  clipToWidth,
  createKeyByteParser,
  createMenuState,
  parseKeyBytes,
  renderMenu,
  sanitizeText,
  stepMenu,
} from "../../../kernel/src/addons/menu/list.ts";

const encode = (value: string) => new TextEncoder().encode(value);

describe("menu list pure state machine", () => {
  const rows: readonly MenuRow<{
    readonly id: string;
    readonly secret: string;
  }>[] = [
    { label: "Alpha", value: { id: "a", secret: "SECRET_A" } },
    { label: "Beta", value: { id: "b", secret: "SECRET_B" } },
    { label: "Gamma", value: { id: "g", secret: "SECRET_G" } },
  ];

  test("renders lines above the list, marks the selected row, and never prints row values", () => {
    const state = createMenuState(["Warning line.", "Open what?"], rows);
    const screen = renderMenu(state, { columns: 80, rows: 24 });
    expect(screen).toEqual([
      "Warning line.",
      "Open what?",
      "Filter: ",
      "> Alpha",
      "  Beta",
      "  Gamma",
    ]);
    expect(screen.join("\n")).not.toContain("SECRET_");
  });

  test("moves with arrows and Ctrl-N / Ctrl-P, clamps at ends, and picks on Enter", () => {
    let state = createMenuState(["Open what?"], rows);
    for (const seq of [
      "\x1b[A",
      "\x1b[B",
      "\x0e",
      "\x1bOB",
      "\x1b[A",
      "\x10",
      "\x1b[B",
    ]) {
      for (const key of parseKeyBytes(encode(seq))) {
        const next = stepMenu(state, key);
        expect(next.result).toBeUndefined();
        state = next.state;
      }
    }
    const [enter] = parseKeyBytes(encode("\r"));
    expect(enter).toBeDefined();
    if (!enter) return;
    const picked = stepMenu(state, enter);
    expect(picked.result).toEqual({
      kind: "picked",
      value: { id: "b", secret: "SECRET_B" },
      index: 1,
    });
  });

  test("filters by case-insensitive substring, edits with Backspace, and returns the original row index", () => {
    let state = createMenuState(["Open what?"], rows);
    for (const key of parseKeyBytes(encode("gax\x7fm"))) {
      const next = stepMenu(state, key);
      expect(next.result).toBeUndefined();
      state = next.state;
    }
    expect(state.filter).toBe("gam");
    expect(renderMenu(state, { columns: 80, rows: 24 })).toEqual([
      "Open what?",
      "Filter: gam",
      "> Gamma",
    ]);
    const [enter] = parseKeyBytes(encode("\r"));
    expect(enter).toBeDefined();
    if (!enter) return;
    const picked = stepMenu(state, enter);
    expect(picked.result).toEqual({
      kind: "picked",
      value: { id: "g", secret: "SECRET_G" },
      index: 2,
    });
  });

  test("Enter on zero matches stays open and Backspace recovers matches", () => {
    let state = createMenuState(["Open what?"], rows);
    for (const key of parseKeyBytes(encode("zzz\r"))) {
      const next = stepMenu(state, key);
      expect(next.result).toBeUndefined();
      state = next.state;
    }
    expect(renderMenu(state, { columns: 80, rows: 24 })).toContain(
      "  (no matches)",
    );
    for (const key of parseKeyBytes(encode("\x08\x08\x08b\r"))) {
      const next = stepMenu(state, key);
      state = next.state;
      if (next.result) {
        expect(next.result).toEqual({
          kind: "picked",
          value: { id: "b", secret: "SECRET_B" },
          index: 1,
        });
        return;
      }
    }
    throw new Error("Expected Backspace then b then Enter to pick Beta.");
  });

  test("Esc cancels, Ctrl-C interrupts, and Ctrl-Z and unknown CSI sequences are ignored", () => {
    const state = createMenuState(["Open what?"], rows);
    expect(parseKeyBytes(encode("\x1b"))).toEqual([{ kind: "cancel" }]);
    expect(stepMenu(state, { kind: "cancel" }).result).toEqual({
      kind: "cancelled",
    });

    expect(parseKeyBytes(encode("\x03"))).toEqual([{ kind: "interrupt" }]);
    expect(stepMenu(state, { kind: "interrupt" }).result).toEqual({
      kind: "interrupt",
    });

    expect(parseKeyBytes(encode("\x1a"))).toEqual([]);
    expect(parseKeyBytes(encode("\x1b[C\x1b[D\x1b[1;5A"))).toEqual([]);
  });

  test("strips CSI/OSC escapes, C0 and C1 control characters, and bidirectional overrides before drawing", () => {
    const dirtyLabel =
      "\x1b[2J\x1b]0;title\x07\u009b31m\u202eAlpha\x00\x07\r\n\u0085\u2066!\u2069";
    expect(sanitizeText(dirtyLabel)).toBe("Alpha!");
    const state = createMenuState(
      ["\x1b[31mWarn\x07\u202e"],
      [{ label: "\x1b[2JTarget", value: 1 }],
    );
    const screen = renderMenu(state, { columns: 80, rows: 24 });
    expect(screen).toEqual(["Warn", "Filter: ", "> Target"]);
    for (const line of screen) {
      expect(line.includes("\x1b")).toBe(false);
      expect(line.includes("\x07")).toBe(false);
      expect(line.includes("\u202e")).toBe(false);
    }
  });

  test("clips lines to terminal columns and scrolls rows within terminal height", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      label: `Item-${String(index).padStart(2, "0")}-long-label`,
      value: index,
    }));
    let state = createMenuState(["Header line that is very long"], many);
    const initial = renderMenu(state, { columns: 12, rows: 5 });
    expect(initial).toHaveLength(5);
    for (const line of initial)
      expect([...line].length).toBeLessThanOrEqual(12);
    expect(initial[2]).toBe("> Item-00-lo");

    for (let step = 0; step < 6; step += 1) {
      state = stepMenu(state, { kind: "down" }).state;
    }
    const scrolled = renderMenu(state, { columns: 12, rows: 5 });
    expect(scrolled).toHaveLength(5);
    expect(scrolled.some((line) => line.startsWith("> Item-06"))).toBe(true);
  });

  test("clamps NaN and non-finite dimensions instead of bypassing clipping", () => {
    expect(clipToWidth("abcdef", Number.NaN)).toBe("a");
    expect(clipToWidth("abcdef", Number.POSITIVE_INFINITY)).toBe("a");
    expect(clipToWidth("abcdef", Number.NEGATIVE_INFINITY)).toBe("a");

    const longLabel = "x".repeat(120);
    const state = createMenuState(
      ["h".repeat(120)],
      [{ label: longLabel, value: 1 }],
    );
    const nanScreen = renderMenu(state, {
      columns: Number.NaN,
      rows: Number.NaN,
    });
    expect(nanScreen).toHaveLength(3);
    for (const line of nanScreen)
      expect([...line].length).toBeLessThanOrEqual(80);

    const infScreen = renderMenu(state, {
      columns: Number.POSITIVE_INFINITY,
      rows: Number.POSITIVE_INFINITY,
    });
    expect(infScreen).toHaveLength(3);
    for (const line of infScreen)
      expect([...line].length).toBeLessThanOrEqual(80);
  });

  test("keeps escape sequence and UTF-8 parser state across split chunks", () => {
    const parser = createKeyByteParser();
    expect(parser.push(encode("\x1b"))).toEqual([]);
    expect(parser.hasPendingEscape()).toBe(true);
    expect(parser.push(encode("[B"))).toEqual([{ kind: "down" }]);
    expect(parser.hasPendingEscape()).toBe(false);
    expect(parser.push(encode("\x1b"))).toEqual([]);
    expect(parser.push(encode("O"))).toEqual([]);
    expect(parser.hasPendingEscape()).toBe(false);
    expect(parser.push(encode("A"))).toEqual([{ kind: "up" }]);
    expect(parser.push(encode("\x1b[1;"))).toEqual([]);
    expect(parser.push(encode("5A"))).toEqual([]);
    expect(parser.push(new Uint8Array([0xe7, 0x95]))).toEqual([]);
    expect(parser.push(new Uint8Array([0x8c]))).toEqual([
      { kind: "text", value: "\u754c" },
    ]);
    expect(parser.push(encode("\x1b"))).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: "cancel" }]);
  });
});
