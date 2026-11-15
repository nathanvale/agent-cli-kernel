import { expect } from "bun:test";
import { versionReader } from "../../../starters/contract3/src/kernel/index.ts";
import type { MinorFields } from "../../../starters/contract3/src/kernel/index.ts";
import { runFamily } from "./harness.ts";

// Test-owned minor tables (R10); nothing here comes from the kernel's tables.
const causes = ["SUCCESS_UNCHANGED"];
const t0: MinorFields = {
  minor: 0,
  fields: { message: { required: true, meaning: "Message." } },
  commonCauses: causes,
};
function next(fields: MinorFields["fields"]): MinorFields {
  return {
    minor: 1,
    fields: { ...t0.fields, ...fields },
    commonCauses: causes,
  };
}
const prototypeNames = ["toString", "constructor", "hasOwnProperty", "valueOf"];

runFamily("R10", {
  "R10.prototype-key-payload-refused": () => {
    const reader = versionReader([t0]);
    for (const name of prototypeNames)
      expect(reader.fields("3.0.0", { message: "m", [name]: "x" })).toBe(false);
  },
  "R10.proto-key-payload-refused": () => {
    const payload: unknown = JSON.parse('{"message":"m","__proto__":1}');
    expect(typeof payload === "object" && payload !== null).toBe(true);
    if (typeof payload !== "object" || payload === null) return;
    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    expect(versionReader([t0]).fields("3.0.0", { ...payload })).toBe(false);
    expect(
      versionReader([t0]).fields(
        "3.0.0",
        Object.fromEntries(Object.entries(payload)),
      ),
    ).toBe(false);
  },
  "R10.required-prototype-name-absent": () => {
    const reader = versionReader([
      {
        ...t0,
        fields: {
          ...t0.fields,
          toString: { required: true, meaning: "Required text." },
        },
      },
    ]);
    expect(reader.fields("3.0.0", { message: "m" })).toBe(false);
  },
  "R10.minor-required-prototype-name-throws": () => {
    for (const name of ["toString", "constructor"])
      expect(() =>
        versionReader([
          t0,
          next({ [name]: { required: true, meaning: "Added." } }),
        ]),
      ).toThrow();
  },
  "R10.minor-optional-prototype-name-admitted": () => {
    const reader = versionReader([
      t0,
      next({
        toString: { required: false, meaning: "Added." },
        constructor: { required: false, meaning: "Added." },
      }),
    ]);
    expect(reader.fields("3.1.0", { message: "m", toString: "x" })).toBe(true);
  },
  "R10.valid-twin": () => {
    expect(versionReader([t0]).fields("3.0.0", { message: "m" })).toBe(true);
  },
});
