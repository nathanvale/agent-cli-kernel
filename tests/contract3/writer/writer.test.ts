// T2 writer, fallback and exit-agreement process cases (W01 to W05, F01 to
// F04, X01). Each test runs the labelled fault-fixture CLI as a real process.
import { describe, expect, test } from "bun:test";
import { encodeBounded } from "../../../starters/contract3/src/kernel/fallback.ts";
import { assertEnvelope, assertHuman, receipt } from "../lifecycle/checks.ts";
import { sliceCases } from "../lifecycle/coverage.ts";
import {
  caseById,
  cleanup,
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

describe("fallback encoder bound (component support for F04 encoding)", () => {
  test("rejects values above the byte or depth bound and non-plain values", () => {
    expect(encodeBounded({ a: [1, "x", null, true] })).toBe(
      '{"a":[1,"x",null,true]}',
    );
    expect(encodeBounded("x".repeat(16_381))).toBe(`"${"x".repeat(16_381)}"`);
    expect(encodeBounded("x".repeat(16_382))).toBeUndefined();
    expect(encodeBounded([[[[[[[[]]]]]]]])).toBe("[[[[[[[[]]]]]]]]");
    expect(encodeBounded([[[[[[[[[]]]]]]]]])).toBeUndefined();
    expect(encodeBounded({ a: Number.NaN })).toBeUndefined();
    expect(encodeBounded({ a: new Date(0) })).toBeUndefined();
    expect(encodeBounded([undefined])).toBeUndefined();
  });
});
