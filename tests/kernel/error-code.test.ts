import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { errorCode } from "../../kernel/src/shared/error-code.ts";

class InheritedCodeError extends Error {}
Object.defineProperty(InheritedCodeError.prototype, "code", {
  value: "ENOENT",
});

function withOwnCode(target: object, value: unknown): object {
  Object.defineProperty(target, "code", {
    value,
    enumerable: true,
    configurable: true,
  });
  return target;
}

describe("errorCode", () => {
  test("EC01.a reads an own string code from an Error, a plain object, and a null-prototype object", () => {
    const nativeError = withOwnCode(new Error("missing"), "ENOENT");
    const nullProto: unknown = Object.create(null);
    if (typeof nullProto !== "object" || nullProto === null)
      throw new Error("expected null-prototype object");
    withOwnCode(nullProto, "EACCES");

    expect(errorCode(nativeError)).toBe("ENOENT");
    expect(errorCode({ code: "EEXIST" })).toBe("EEXIST");
    expect(errorCode(nullProto)).toBe("EACCES");
  });

  test("EC01.b ignores a code inherited from the prototype", () => {
    const inheritedError = new InheritedCodeError("from-prototype");
    const inheritedPlain: unknown = Object.create({ code: "ENOENT" });
    const shadowedError = withOwnCode(
      new InheritedCodeError("shadowed"),
      "EPERM",
    );

    expect(errorCode(inheritedError)).toBeUndefined();
    expect(errorCode(inheritedPlain)).toBeUndefined();
    expect(errorCode(shadowedError)).toBe("EPERM");
  });

  test("EC02.a reads an own code getter once", () => {
    let reads = 0;
    const error = new Error("getter");
    Object.defineProperty(error, "code", {
      get() {
        reads += 1;
        return reads === 1 ? "ENOENT" : "EACCES";
      },
    });

    expect(errorCode(error)).toBe("ENOENT");
    expect(reads).toBe(1);
  });

  test("EC03.a reads an own string code from a non-Error object and an Error created in another realm", () => {
    const foreignPlain: unknown = runInNewContext('({ code: "ENOENT" })');
    const foreignError: unknown = runInNewContext(
      'Object.defineProperty(new Error("foreign"), "code", { value: "ESRCH", enumerable: true })',
    );
    const foreignInherited: unknown = runInNewContext(
      'Object.create({ code: "ENOENT" })',
    );

    expect(foreignPlain instanceof Error).toBe(false);
    expect(foreignError instanceof Error).toBe(false);
    expect(errorCode(foreignPlain)).toBe("ENOENT");
    expect(errorCode(foreignError)).toBe("ESRCH");
    expect(errorCode(foreignInherited)).toBeUndefined();
  });

  test("EC04.a returns undefined when own code is not a string", () => {
    const values: readonly unknown[] = [
      withOwnCode(new Error("number"), 42),
      { code: 42 },
      { code: null },
      { code: undefined },
      { code: true },
      { code: ["ENOENT"] },
      new Error("without-code"),
    ];

    for (const value of values) expect(errorCode(value)).toBeUndefined();
  });

  test("EC05.a returns undefined for non-object and null inputs", () => {
    const values: readonly unknown[] = [
      "ENOENT",
      42,
      true,
      false,
      null,
      undefined,
      Symbol("ENOENT"),
    ];

    for (const value of values) expect(errorCode(value)).toBeUndefined();
  });
});
