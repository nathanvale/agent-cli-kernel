import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { hits, templateSourceFile } from "../../support/template-lint.ts";

test("require-to-throw-message refuses a bare rejects.toThrow()", async () => {
  const found = await hits(
    "require-to-throw-message",
    "tests/template/doctor/doctor.test.ts",
    'await expect(Promise.reject(new Error("limit"))).rejects.toThrow();',
  );
  expect(found.map(({ line }) => line)).toEqual([1]);
});

const bypasses = [
  [
    "require-to-throw-message",
    "expect(fn).toThrow(undefined);",
    "toThrow(undefined) names no message",
  ],
  [
    "require-to-throw-message",
    'expect(fn).toThrow("");',
    'toThrow("") names no message',
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrowError(``);",
    "toThrowError(``) names no message",
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrow(/.*/);",
    "toThrow(/.*/) names no message",
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrow(/.+/);",
    "toThrow(/.+/) names no message",
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrow(/^/);",
    "toThrow(/^/) names no message",
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrow(/(?:)/);",
    "toThrow(/(?:)/) names no message",
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrow(/limit|/);",
    "toThrow(/limit|/) names no message",
  ],
  ["require-to-throw-message", "expect(fn).toThrow(/limit/);", undefined],
  ["require-to-throw-message", "expect(fn).not.toThrow(undefined);", undefined],
  ["require-to-throw-message", 'expect(fn)["toThrow"]();', "bare toThrow()"],
  [
    "require-to-throw-message",
    'expect(fn)["toThrowError"]("");',
    'toThrowError("") names no message',
  ],
  [
    "require-to-throw-message",
    'await expect(work)["rejects"]["toThrow"]();',
    "bare toThrow()",
  ],
  ["require-to-throw-message", 'expect(fn)["not"].toThrow();', undefined],
  ["require-to-throw-message", 'expect(fn)["not"]["toThrow"]();', undefined],
  ["require-to-throw-message", 'expect(fn)["toThrow"]("limit");', undefined],
  [
    "tests-use-test-folder",
    'import { tmpdir as td2 } from "node:os";\ntd2();',
    "tmpdir() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'import * as os from "node:os";\nconst { tmpdir: td } = os;\ntd();',
    "tmpdir() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'import os from "os";\nos["tmpdir"]();',
    "tmpdir() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'import * as os from "node:os";\nconst td = os.tmpdir;\ntd();',
    "tmpdir() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'import { mkdtempSync as make } from "fs";\nmake("x");',
    "mkdtempSync() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'import fsp from "node:fs/promises";\nawait fsp["mkdtemp"]("x");',
    "mkdtemp() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'const { mkdtemp: make } = await import("fs/promises");\nawait make("x");',
    "mkdtemp() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'const { tmpdir: td } = require("node:os");\ntd();',
    "tmpdir() ignores STATE_TEST_DIR",
  ],
  [
    "tests-use-test-folder",
    'import { homedir as td } from "node:os";\ntd();',
    undefined,
  ],
  [
    "tests-use-test-folder",
    'import * as os from "node:os";\nconst { tmpdir: td, ...rest } = os;\ntd();\nrest.homedir();',
    "tmpdir() ignores STATE_TEST_DIR",
  ],
  ...[
    "const { ...rest } = { value: 1 };\nexpect(rest.value).toBe(1);",
    "const { ...copy } = service;\ncopy.run();",
    "const { a: { b }, c = { d: 1 }, ...rest } = source;\nb.run();\nc.d.toString();\nrest.run();",
    "const [, first, [second] = [], { third }, ...others] = list;\nfirst.run();\nsecond.run();\nthird.run();\nothers.at(0);",
  ].flatMap((code) =>
    (["tests-use-test-folder", "tests-no-sleep"] as const).map(
      (rule) => [rule, code, undefined] as const,
    ),
  ),
  [
    "tests-no-sleep",
    'import timers from "node:timers/promises";\nawait timers.setTimeout(5);',
    "The node:timers/promises module",
  ],
  [
    "tests-no-sleep",
    'import * as tp from "timers/promises";\nawait tp.setTimeout(5);',
    "The node:timers/promises module",
  ],
  [
    "tests-no-sleep",
    'const { setTimeout: s } = await import("node:timers/promises");\nawait s(5);',
    "The node:timers/promises module",
  ],
  [
    "tests-no-sleep",
    'import { setImmediate } from "node:timers/promises";\nawait setImmediate();',
    undefined,
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => setTimeout(() => r(undefined), 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => setTimeout(() => { r(undefined); }, 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => globalThis.setTimeout(r, 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    'import { setTimeout as st } from "node:timers";\nawait new Promise((r) => st(r, 5));',
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    'import timers from "timers";\nawait new Promise((r) => timers.setTimeout(r, 5));',
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => { const t = setTimeout(() => r(undefined), 5); String(t); });",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "let t: ReturnType<typeof setTimeout> | undefined;\nconst p = new Promise((r) => { t = setTimeout(r, 5); });\nawait p;\nclearTimeout(t);",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => setTimeout(r, 5, undefined));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    'await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 5, "timeout"))]);',
    undefined,
  ],
  ["tests-no-sleep", 'await Bun["sleep"](5);', "Bun.sleep waits"],
  [
    "tests-no-sleep",
    "const { sleep } = Bun;\nawait sleep(5);",
    "Bun.sleep waits",
  ],
  [
    "tests-no-sleep",
    "const Bun = { sleep: (ms: number) => ms };\nBun.sleep(5);",
    undefined,
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => (0, setTimeout)(r, 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => setTimeout(r as () => void, 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => (setTimeout as typeof setTimeout)(r, 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "await new Promise((r) => setTimeout(() => r(void 0), 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "tests-no-sleep",
    "const g = globalThis;\nconst t = g.setTimeout;\nconst u = t;\nawait new Promise((r) => u(r, 5));",
    "A promise that setTimeout only resolves",
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrow(undefined as never);",
    "toThrow(undefined as never) names no message",
  ],
  [
    "require-to-throw-message",
    "expect(fn).toThrow(void 0);",
    "toThrow(void 0) names no message",
  ],
  [
    "no-host-path-literal",
    "const folder = (name: string) => `/private/tmp/${name}`;",
    '"/private/tmp/" names a folder on one host',
  ],
  [
    "no-host-path-literal",
    'const home = "/Users/someone/project";',
    '"/Users/someone/project" names a folder on one host',
  ],
  ["no-host-path-literal", 'const scratch = "/tmp";', '"/tmp" names a folder'],
  [
    "no-host-path-literal",
    "const raw = String.raw`/tmp/\\unicode`;",
    '"/tmp/\\unicode" names a folder',
  ],
  [
    "no-host-path-literal",
    "const nested = (root: string) => `${root}/tmp/x`;",
    undefined,
  ],
  ["no-host-path-literal", 'const sink = "/dev/null";', undefined],
  [
    "no-host-path-literal",
    'const shell = ["/bin/sh", "-c", "exit 0"];',
    undefined,
  ],
  ["no-host-path-literal", 'const stub = "#!/bin/sh\\nexit 0\\n";', undefined],
  ["no-host-path-literal", 'const page = "/homepage";', undefined],
] as const;

for (const [rule, code, fix] of bypasses)
  test(`${rule} ${fix ? "refuses" : "admits"} ${code} and names the fix`, async () => {
    const found = await hits(
      rule,
      "tests/template/doctor/doctor.test.ts",
      code,
    );
    expect(
      found.map(({ message }) => fix !== undefined && message.includes(fix)),
    ).toEqual(fix ? [true] : []);
  });

const ownData = [
  [
    'export const has = (value: object) => "toString" in value;',
    "the in operator also finds inherited members such as toString",
  ],
  [
    'export const has = (value: object) => Reflect.has(value, "payload");',
    'Repair: (Object.hasOwn(value, "payload")',
  ],
  [
    'export const has = (value: object) => Reflect[`has`](value, "toString");',
    'Repair: (Object.hasOwn(value, "toString")',
  ],
  [
    'type Shape = { kind: "a"; a: number } | { kind: "b"; b: string };\nexport const has = (shape: Shape) => Reflect["has"](shape, "a");',
    undefined,
  ],
  [
    "export const keys = (value: object) => {\n  for (const key in value) return key;\n};",
    "Repair: for (const key of Object.keys(value))",
  ],
  [
    "export const keys = (value: object) => {\n  for (let field in value) return field;\n};",
    "Repair: for (let field of Object.keys(value))",
  ],
  [
    'export const once = (read: () => object) => "payload" in read();',
    'Repair: const key = "payload"; const target = read(); const own: unknown',
  ],
  [
    'export const once = (host: { readonly value: object }) => "payload" in host.value;',
    'Repair: const key = "payload"; const target = host.value; const own: unknown',
  ],
  [
    "export const once = (source: object, keys: { readonly key: string }) => keys.key in source;",
    "Repair: const key = keys.key; const target = source; const own: unknown",
  ],
  [
    "export const once = (target: () => object, own: string) => own in target();",
    "Repair: const key = own; const target2 = target(); const own2: unknown = Object.hasOwn(target2, key) ? Reflect.get(target2, key) : undefined;",
  ],
  [
    'type Shape = { kind: "a"; a: number } | { kind: "b"; b: string };\nexport const read = (shape: Shape) => ("a" in shape ? shape.a : shape.b);',
    undefined,
  ],
  [
    'export function has<T extends { a: number } | { b: string }>(value: T) {\n  return "a" in value;\n}',
    undefined,
  ],
  [
    'export function has<T extends { a: number } | { b: string }>(value: T) {\n  return "c" in value;\n}',
    'Repair: (Object.hasOwn(value, "c")',
  ],
  [
    'export const has = (value: object) => Object.hasOwn(value, "payload");',
    undefined,
  ],
  [
    "export class Box {\n  #id = 1;\n  static has(value: object) {\n    return #id in value;\n  }\n}",
    undefined,
  ],
] as const;

for (const [code, fix] of ownData)
  test(`no-in-operator ${fix ? "refuses" : "admits"} ${JSON.stringify(code)} in ${templateSourceFile}`, async () => {
    const found = await hits("no-in-operator", templateSourceFile, code);
    expect(
      found.map(({ message }) => fix !== undefined && message.includes(fix)),
    ).toEqual(fix ? [true] : []);
  });

test("tests-use-test-folder admits the folder calls inside its owner module", async () => {
  expect(
    await hits(
      "tests-use-test-folder",
      "tests/support/test-folder.ts",
      await Bun.file(
        resolve(import.meta.dir, "../../support/test-folder.ts"),
      ).text(),
    ),
  ).toEqual([]);
});

const sleeps = [
  ["await new Promise((r) => setTimeout(r, 5));", true],
  [
    "await new Promise<void>((resolve) => { setTimeout(() => resolve(), 5); });",
    true,
  ],
  ['import { setTimeout as delay } from "node:timers/promises";', true],
  ["Bun.sleepSync(2);", true],
  [
    'new Promise((_, reject) => setTimeout(() => reject(new Error("bound")), 5));',
    false,
  ],
  ["const controller = new AbortController();", false],
  ["setTimeout(() => controller.abort(), 5);", false],
  ['new Promise((resolve) => setTimeout(() => resolve("timeout"), 5));', false],
] as const;

test("tests-no-sleep refuses a promise delay and admits a watchdog", async () => {
  const found = await hits(
    "tests-no-sleep",
    "tests/template/doctor/doctor.test.ts",
    sleeps.map(([line]) => line).join("\n"),
  );
  expect(found.map(({ line }) => line)).toEqual(
    sleeps.flatMap(([, refused], index) => (refused ? [index + 1] : [])),
  );
});
