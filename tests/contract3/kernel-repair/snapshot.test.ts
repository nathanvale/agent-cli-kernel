import { expect } from "bun:test";
import { envelope, envelopeContract, readStation } from "./envelope-fixture.ts";
import { unchanged } from "./shapes.ts";
import { runFamily } from "./harness.ts";

runFamily("R06", {
  "R06.mutation-during-await": async () => {
    const value = envelope({ n: 1 });
    const pristine = structuredClone(value);
    const pending = envelopeContract().validate(value);
    Reflect.set(value.result, "exitCode", 99);
    Reflect.set(value.result, "data", () => 1);
    Reflect.set(value, "extra", 1);
    const checked = await pending;
    if (checked.ok) {
      expect(checked.value).not.toBe(value);
      expect<unknown>(checked.value).toEqual(pristine);
    }
  },
  "R06.mutation-after-resolve": async () => {
    const value = envelope({ n: 1 });
    const pristine = structuredClone(value);
    const checked = await envelopeContract().validate(value);
    expect(checked.ok).toBe(true);
    Reflect.set(value.result, "exitCode", 99);
    Reflect.set(value, "extra", 1);
    if (checked.ok) expect<unknown>(checked.value).toEqual(pristine);
  },
  "R06.build-data-mutation": async () => {
    const data = { n: 1 };
    const pending = envelopeContract().build(readStation, {
      runId: "run-1",
      message: "Built.",
      data,
      effects: unchanged,
    });
    data.n = 2;
    const built = await pending;
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect<unknown>(built.value.result.data).toEqual({ n: 1 });
    expect<unknown>(built.value.result.data).not.toBe(data);
  },
});
