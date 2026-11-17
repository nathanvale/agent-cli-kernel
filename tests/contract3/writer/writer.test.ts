import { describe, expect, test } from "bun:test";
import { encodeBounded } from "../../../starters/contract3/src/kernel/fallback.ts";
import { assertEnvelope, assertHuman, receipt } from "../lifecycle/checks.ts";
import { sliceCases } from "../lifecycle/coverage.ts";
import { json } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import {
  caseById,
  cleanup,
  deepestLevel,
  envelopeOf,
  n,
  resultOf,
  run,
  text,
} from "../lifecycle/harness.ts";
import type { Case, Observed } from "../lifecycle/harness.ts";

const timeout = 30_000;

function count(observed: Observed, line: string) {
  return observed.ledger.filter((entry) => entry === line).length;
}

async function check(entry: Case) {
  const observed = await run(entry);
  try {
    receipt(entry, observed);
    switch (entry.family) {
      case "W02":
        assertHuman(entry, observed);
        return;
      case "W03": {
        const twinId = entry.expect.twinOf;
        if (typeof twinId !== "string") throw new Error("W03 needs a twin.");
        const twin = caseById(twinId);
        const closed = await run(twin);
        try {
          if (twin.family === "W02") {
            assertHuman(twin, observed);
            expect(text(observed.stdout)).toBe(text(closed.stdout));
          } else {
            assertEnvelope(twin, observed);
            const held = resultOf(envelopeOf(observed.stdout));
            const plain = resultOf(envelopeOf(closed.stdout));
            expect({ ...held, runId: "" }).toEqual({ ...plain, runId: "" });
          }
          expect(text(observed.stderr)).toBe(text(closed.stderr));
          expect(observed.code).toBe(closed.code);
        } finally {
          await cleanup(closed);
        }
        return;
      }
      case "F04": {
        const expected = entry.expect;
        expect(observed.signal).toBeNull();
        expect(observed.code).toBe(1);
        expect(observed.stderr.byteLength).toBe(0);
        expect(count(observed, "stdout-write fallback")).toBe(
          n(expected.fallbackWriteAttempts),
        );
        if (expected.stdout === "empty")
          expect(observed.stdout.byteLength).toBe(0);
        if (expected.stdout === "prefix") {
          const raw = text(observed.stdout);
          expect(raw.length).toBeGreaterThan(0);
          expect(raw.includes("\n")).toBe(false);
          expect(() => {
            JSON.parse(raw);
          }).toThrow();
          expect(count(observed, "stdout-write result")).toBe(1);
        }
        return;
      }
      default:
        assertEnvelope(entry, observed);
    }
  } finally {
    await cleanup(observed);
  }
}

describe("T2 writer process cases", () => {
  for (const entry of sliceCases("writer"))
    test(entry.id, () => check(entry), timeout);
});

describe("writer guard after kernel build (supporting W04, not a frozen case)", () => {
  test(
    "a non-JSON value injected after build never reaches stdout coerced",
    async () => {
      const observed = await run({
        ...caseById("W04.nan"),
        argv: ["read", "--json"],
        scenario: "corrupt:nan-data",
      });
      try {
        assertEnvelope(
          {
            ...caseById("W04.nan"),
            expect: {
              ...caseById("W04.nan").expect,
              commandIdentity: "fx.read",
            },
          },
          observed,
        );
      } finally {
        await cleanup(observed);
      }
    },
    timeout,
  );
});

describe("fallback encoder bound (component support for F04 encoding)", () => {
  test("rejects values above the byte or depth bound and non-plain values", () => {
    expect(encodeBounded({ a: [1, "x", null, true] })).toBe(
      '{"a":[1,"x",null,true]}',
    );
    expect(encodeBounded("x".repeat(16_381))).toBe(`"${"x".repeat(16_381)}"`);
    expect(encodeBounded("x".repeat(16_382))).toBeUndefined();
    expect(encodeBounded([[[[[[[[]]]]]]]])).toBe("[[[[[[[[]]]]]]]]");
    expect(encodeBounded([[[[[[[[[]]]]]]]]])).toBe("[[[[[[[[[]]]]]]]]]");
    expect(encodeBounded([[[[[[[[[[]]]]]]]]]])).toBeUndefined();
    expect(encodeBounded([[[[[[[[1]]]]]]]])).toBe("[[[[[[[[1]]]]]]]]");
    expect(encodeBounded([[[[[[[[[1]]]]]]]]])).toBeUndefined();
    expect(encodeBounded({ a: Number.NaN })).toBeUndefined();
    expect(encodeBounded({ a: new Date(0) })).toBeUndefined();
    expect(encodeBounded([undefined])).toBeUndefined();
  });
});

function arrays(count: number, scalar?: number | string): unknown {
  let value: unknown = scalar === undefined ? [] : [scalar];
  for (let level = 1; level < count; level++) value = [value];
  return value;
}

describe("one depth rule for the 64 and 8 limits (supporting B2)", () => {
  test("B2.01.encoder-boundary-table", () => {
    for (const [input, admitted] of [
      [arrays(8), true],
      [arrays(9), true],
      [arrays(10), false],
      [arrays(8, 1), true],
      [arrays(9, 1), false],
    ] as const)
      expect(encodeBounded(input) !== undefined).toBe(admitted);
  });

  test("B2.04.one-rule-two-limits", () => {
    const envelope = (data: unknown) => ({
      contractVersion: "3.0.0",
      message: "m",
      availablePaths: [],
      result: { data },
    });
    for (const [data, admitted] of [
      [arrays(63), true],
      [arrays(64), false],
      [arrays(62, 1), true],
      [arrays(63, 1), false],
    ] as const) {
      const whole = envelope(data);
      expect(deepestLevel(whole) <= 64).toBe(admitted);
      expect(json(whole)).toBe(admitted);
    }
    for (const input of [
      arrays(8),
      arrays(9),
      arrays(10),
      arrays(8, 1),
      arrays(9, 1),
    ])
      expect(encodeBounded(input) !== undefined).toBe(deepestLevel(input) <= 8);
  });

  for (const [depth, causeCode, exit] of [
    [62, "SUCCESS_UNCHANGED", 0],
    [63, "INTERNAL_RESULT_UNCHANGED", 1],
  ] as const)
    test(
      `B2.03.result-guard-scalar-at-level-${String(depth + 2)}`,
      async () => {
        const entry = {
          ...caseById("W04.max-depth-twin"),
          id: `B2.03.scalar-${String(depth)}`,
          argv: [
            "bad",
            "--variant",
            "depth-scalar",
            "--depth",
            String(depth),
            "--json",
          ],
          expect:
            exit === 1
              ? { commandIdentity: "fx.bad", causeCode, exit, fallback: true }
              : { commandIdentity: "fx.bad", causeCode, exit },
        };
        const observed = await run(entry);
        try {
          assertEnvelope(entry, observed);
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );
});
