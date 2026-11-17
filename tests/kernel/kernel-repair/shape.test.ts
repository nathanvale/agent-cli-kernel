import { expect } from "bun:test";
import { envelope, envelopeContract } from "./envelope-fixture.ts";
import { runFamily } from "./harness.ts";

function hidden<Target>(target: Target, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return target;
}
async function verdict(value: unknown) {
  return (await envelopeContract().validate(value)).ok;
}

runFamily("R07", {
  "R07.hidden-required-key-refused": async () => {
    const value = envelope(null);
    hidden(value.result, "runId", "run-1");
    expect(JSON.stringify(value)).not.toContain("runId");
    expect(await verdict(value)).toBe(false);
  },
  "R07.hidden-tojson-refused": async () => {
    const data = hidden({ a: 1 }, "toJSON", () => "rewritten");
    expect(await verdict(envelope(data))).toBe(false);
  },
  "R07.hidden-data-property-refused": async () => {
    const data = hidden({ a: 1 }, "b", 2);
    expect(await verdict(envelope(data))).toBe(false);
  },
  "R07.array-extra-enumerable-refused": async () => {
    const data = Object.defineProperty([1, 2], "extra", {
      value: 3,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(await verdict(envelope(data))).toBe(false);
  },
  "R07.array-extra-hidden-refused": async () => {
    const data = hidden([1, 2], "extra", 3);
    expect(await verdict(envelope(data))).toBe(false);
  },
  "R07.round-trip-twin": async () => {
    for (const data of [
      null,
      { a: [1, { b: null }], c: "x", d: true },
      [[], {}, [1, "two", false]],
    ]) {
      const value = envelope(data);
      const checked = await envelopeContract().validate(value);
      expect(checked.ok).toBe(true);
      if (!checked.ok) continue;
      const wire: unknown = JSON.parse(JSON.stringify(checked.value));
      expect(wire).toEqual(value);
      for (const key of [
        "runId",
        "commandIdentity",
        "outcome",
        "effectClass",
        "transactionState",
        "causeCode",
        "failureClass",
        "exitCode",
        "data",
        "retryable",
        "repairAction",
        "effects",
      ]) {
        const result: unknown =
          typeof wire === "object" && wire !== null
            ? Reflect.get(wire, "result")
            : undefined;
        expect(
          typeof result === "object" &&
            result !== null &&
            Object.hasOwn(result, key),
        ).toBe(true);
      }
    }
  },
});
