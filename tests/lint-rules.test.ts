import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const eslint = new ESLint({ cwd: root });

async function messages(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map(({ ruleId, line, message }) => ({
    ruleId,
    line,
    message,
  }));
}

const templateRules = (
  await Promise.all(
    [
      "../config/template-rules.mjs",
      "../config/platform-rules.mjs",
      "../config/payload-rules.mjs",
    ].map(async (file) =>
      Object.keys(
        (
          (await import(new URL(file, import.meta.url).href)) as {
            default: { rules: object };
          }
        ).default.rules,
      ),
    ),
  )
).flat();
const kernelPath = /^(kernel|tests\/kernel)\//;
const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter((path) => path !== "" && existsSync(resolve(root, path)));

async function ruleOn(rule: string, filePath: string): Promise<boolean> {
  const config = (await eslint.calculateConfigForFile(filePath)) as
    | { rules?: Record<string, unknown> }
    | undefined;
  const setting = config?.rules?.[rule];
  const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
  return severity !== undefined && severity !== 0 && severity !== "off";
}

async function hits(rule: string, filePath: string, code: string) {
  if (kernelPath.test(filePath) || !existsSync(resolve(root, filePath)))
    throw new Error(`${filePath} is not a template file.`);
  if (!(await ruleOn(`repository/${rule}`, filePath)))
    throw new Error(`repository/${rule} is off for ${filePath}.`);
  return (await messages(filePath, code))
    .filter((message) => message.ruleId === `repository/${rule}`)
    .map(({ line, message }) => ({ line, message }));
}

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(resolve(root, "tsconfig.json"), (path) =>
    ts.sys.readFile(path),
  ).config,
  ts.sys,
  root,
);
let previous: ts.Program | undefined;

function typeErrors(filePath: string, code: string): string[] {
  const target = resolve(root, filePath);
  const host = ts.createCompilerHost(config.options);
  host.getCurrentDirectory = () => root;
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    name === target
      ? ts.createSourceFile(name, code, language)
      : read(name, language, ...rest);
  const program = ts.createProgram([target], config.options, host, previous);
  previous = program;
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(target))
    .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"));
}

async function fixesFor(rule: string, filePath: string, failing: string) {
  const found = await hits(rule, filePath, failing);
  if (found.length === 0) throw new Error(`No ${rule} hit in ${failing}.`);
  return found.map(({ message }) => {
    const fix = message.split(" Repair: ")[1];
    if (fix === undefined) throw new Error(`No fix in ${message}.`);
    return fix;
  });
}

const fixes = [
  {
    rule: "no-locale-compare",
    filePath: "src/static-admission.ts",
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: ([fix]: string[]) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-locale-compare",
    filePath: "scripts/doctor.ts",
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: ([fix]: string[]) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-in-operator",
    filePath: "src/bootstrap.ts",
    failing:
      'export const code = (error: Error): unknown => ("code" in error ? error.code : undefined);',
    fixed: ([fix]: string[]) =>
      `export const code = (error: Error): unknown => ${fix};`,
  },
  {
    rule: "no-in-operator",
    filePath: "src/static-admission.ts",
    failing:
      'export const payload = (next: () => object) => ("payload" in next() ? 1 : 0);',
    fixed: ([fix]: string[]) =>
      `export const payload = (next: () => object): unknown => {\n  ${fix}\n  return own;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: "src/static-admission.ts",
    failing:
      "export const payload = (key: string, read: () => object) => (key in read() ? 1 : 0);",
    fixed: ([fix]: string[]) =>
      `export const payload = (key: string, read: () => object): unknown => {\n  ${fix}\n  return own;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: "src/static-admission.ts",
    failing:
      "export const payload = (key: string, read: () => object) => {\n  {\n    return key in read();\n  }\n};",
    fixed: ([fix]: string[]) =>
      `export const payload = (key: string, read: () => object): unknown => {\n  {\n    ${fix}\n    return own;\n  }\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: "src/static-admission.ts",
    failing:
      'export const payload = (host: { readonly value: object }) => ("payload" in host.value ? 1 : 0);',
    fixed: ([fix]: string[]) =>
      `export const payload = (host: { readonly value: object }): unknown => {\n  ${fix}\n  return own;\n};`,
  },
];

for (const item of fixes)
  test(`${item.rule}: the fix its message names compiles and lints clean in ${item.filePath}`, async () => {
    const found = await fixesFor(item.rule, item.filePath, item.failing);
    const fixed = item.fixed(found);
    expect(typeErrors(item.filePath, fixed)).toEqual([]);
    expect(await messages(item.filePath, fixed)).toEqual([]);
  }, 60_000);

const refused = [
  {
    rule: "no-locale-compare",
    witness: "b456208",
    filePath: "scripts/doctor.ts",
    code: [
      "export const keys = (value: Record<string, unknown>) =>",
      "  Object.entries(value).sort(([left], [right]) => left.localeCompare(right));",
    ],
    lines: [2],
  },
  {
    rule: "no-locale-compare",
    witness: "57c8c8b",
    filePath: "src/static-admission.ts",
    code: [
      'const collator = new Intl.Collator("sv");',
      'export const names = ["a", "b"].sort(collator.compare);',
    ],
    lines: [1],
  },
  {
    rule: "no-locale-compare",
    witness: "aliased bindings",
    filePath: "src/static-admission.ts",
    code: [
      "const { Collator } = Intl;",
      'export const first = new globalThis.Intl.Collator("sv");',
      "const { localeCompare } = String.prototype;",
      'export const second = localeCompare.call("a", "b");',
      'export const third = Reflect.get(Intl, "Coll" + "ator");',
      "export const fourth = new Collator();",
      'export const fifth = Reflect.get(Intl, ["Coll", "ator"].join(""));',
    ],
    lines: [1, 2, 3, 5, 7],
  },
  {
    rule: "no-host-path-literal",
    witness: "8e4ec47",
    filePath: "tests/doctor.test.ts",
    code: [
      "export const roots = (first: (root: string, depth: number) => string) => ({",
      '  foreignFile: first("/usr/share", 2),',
      "});",
    ],
    lines: [2],
  },
  {
    rule: "no-in-operator",
    witness: "r4580070968",
    filePath: "src/static-admission.ts",
    code: [
      "type Fields = Readonly<Record<string, { readonly required: boolean }>>;",
      "export const fields = (table: Fields, value: Readonly<Record<string, unknown>>) =>",
      "  Object.keys(value).every((key) => key in table) &&",
      "  Object.entries(table).every(([key, field]) => !field.required || key in value);",
    ],
    lines: [3, 4],
  },
];

for (const item of refused)
  test(`${item.rule} refuses the ${item.witness} shape in ${item.filePath}`, async () => {
    const found = await hits(item.rule, item.filePath, item.code.join("\n"));
    expect(found.map(({ line }) => line)).toEqual(item.lines);
  });

const cases = [
  {
    rule: "require-to-throw-message",
    witness: "185c90d",
    filePath: "tests/doctor.test.ts",
    failing: [
      'const list = { name: "list" };',
      'expect(() => contractFor({ cli: "notes", commands: [list, list] })).toThrow();',
    ],
    passing: [
      'const list = { name: "list" };',
      'expect(() => contractFor({ cli: "notes", commands: [list, list] })).toThrow(',
      '  "Duplicate command identity.",',
      ");",
      'expect(() => contractFor({ cli: "notes", commands: [list] })).not.toThrow();',
    ],
    line: 2,
    fix: "Repair: pass the message or the cause that the test's name gives",
  },
  {
    rule: "tests-use-test-folder",
    witness: "c0b4bf5",
    filePath: "tests/doctor.test.ts",
    failing: [
      'import { mkdtempSync, realpathSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      "export const folder = () =>",
      '  realpathSync.native(mkdtempSync(join(tmpdir(), "c3-route-")));',
    ],
    passing: [
      'import { testFolder } from "./support/test-folder.ts";',
      'export const folder = () => testFolder("c3-route-");',
    ],
    line: 5,
    fix: "testFolder(prefix) from tests/support/test-folder.ts",
  },
  {
    rule: "tests-no-sleep",
    witness: "d1436c0",
    filePath: "tests/doctor.test.ts",
    failing: [
      "export async function exitWithin(done: Promise<number>, ms: number) {",
      "  const observed = await Promise.race([",
      "    done,",
      "    Bun.sleep(ms).then(() => undefined),",
      "  ]);",
      "  if (observed === undefined) throw new Error(`No exit within ${ms} ms.`);",
      "  return observed;",
      "}",
    ],
    passing: [
      "export async function exitWithin(done: Promise<number>, ms: number) {",
      "  let timer: ReturnType<typeof setTimeout> | undefined;",
      "  const bound = new Promise<never>((_, reject) => {",
      "    timer = setTimeout(() => reject(new Error(`No exit within ${ms} ms.`)), ms);",
      "  });",
      "  try {",
      "    return await Promise.race([done, bound]);",
      "  } finally {",
      "    clearTimeout(timer);",
      "  }",
      "}",
    ],
    line: 4,
    fix: "Repair: wait on the event the test is about",
  },
  {
    rule: "no-host-path-literal",
    witness: "ff5fffe",
    filePath: "tests/doctor.test.ts",
    failing: [
      "export const probe = (separation: (root: string) => boolean) =>",
      '  separation("/private/tmp");',
    ],
    passing: [
      'import { testFolder } from "./support/test-folder.ts";',
      "export const probe = (separation: (root: string) => boolean) =>",
      '  separation(testFolder("separation-"));',
    ],
    line: 2,
    fix: "Repair: make a scratch folder with testFolder(prefix) from tests/support/test-folder.ts",
  },
  {
    rule: "no-in-operator",
    witness: "r4580070979",
    filePath: "src/static-admission.ts",
    failing: [
      "type Fields = Readonly<Record<string, { readonly required: boolean }>>;",
      "export const compatible = (older: Fields, newer: Fields) => {",
      "  for (const [key, field] of Object.entries(newer))",
      '    if (!(key in older) && field.required) throw new Error("A new field must be optional.");',
      "};",
    ],
    passing: [
      "type Fields = Readonly<Record<string, { readonly required: boolean }>>;",
      "export const compatible = (older: Fields, newer: Fields) => {",
      "  for (const [key, field] of Object.entries(newer))",
      '    if (!Object.hasOwn(older, key) && field.required) throw new Error("A new field must be optional.");',
      "};",
    ],
    line: 4,
    fix: "Repair: (Object.hasOwn(older, key) ? Reflect.get(older, key) : undefined)",
  },
  {
    rule: "no-in-operator",
    witness: "r4580077776",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const declared = (fields: Readonly<Record<string, unknown>>, value: object) =>",
      "  Object.keys(value).every((key) => key in fields);",
    ],
    passing: [
      "export const declared = (fields: Readonly<Record<string, unknown>>, value: object) =>",
      "  Object.keys(value).every((key) => Object.hasOwn(fields, key));",
    ],
    line: 2,
    fix: "Repair: (Object.hasOwn(fields, key) ? Reflect.get(fields, key) : undefined)",
  },
];

for (const item of cases)
  test(`${item.rule} refuses the ${item.witness} shape in ${item.filePath} and names the fix`, async () => {
    const found = await hits(item.rule, item.filePath, item.failing.join("\n"));
    expect(found[0]?.line).toBe(item.line);
    expect(found[0]?.message).toContain(item.fix);
    expect(
      await hits(item.rule, item.filePath, item.passing.join("\n")),
    ).toEqual([]);
  });

test("require-to-throw-message refuses a bare rejects.toThrow()", async () => {
  const found = await hits(
    "require-to-throw-message",
    "tests/doctor.test.ts",
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
    const found = await hits(rule, "tests/doctor.test.ts", code);
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
    "export const keys = (value: object) => {\n  for (const key in value) return key;\n};",
    "Repair: for (const key of Object.keys(value))",
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
    'export const has = (value: object) => Object.hasOwn(value, "payload");',
    undefined,
  ],
  [
    "export class Box {\n  #id = 1;\n  static has(value: object) {\n    return #id in value;\n  }\n}",
    undefined,
  ],
] as const;

for (const [code, fix] of ownData)
  test(`no-in-operator ${fix ? "refuses" : "admits"} ${JSON.stringify(code)} in src/static-admission.ts`, async () => {
    const found = await hits("no-in-operator", "src/static-admission.ts", code);
    expect(
      found.map(({ message }) => fix !== undefined && message.includes(fix)),
    ).toEqual(fix ? [true] : []);
  });

test("tests-use-test-folder admits the folder calls inside its owner module", async () => {
  expect(
    await hits(
      "tests-use-test-folder",
      "tests/support/test-folder.ts",
      await Bun.file(resolve(import.meta.dir, "support/test-folder.ts")).text(),
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
    "tests/doctor.test.ts",
    sleeps.map(([line]) => line).join("\n"),
  );
  expect(found.map(({ line }) => line)).toEqual(
    sleeps.flatMap(([, refused], index) => (refused ? [index + 1] : [])),
  );
});

const commentCases = [
  [
    "src/static-admission.ts",
    "// Loop over the names.\nexport const a = 1;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// A workaround until the parser is fixed:\n// it drops the last token.\nexport const a = 1;",
    [1],
  ],
  ["tests/doctor.test.ts", "/* Narration */ export const a = 1;", [1]],
  [
    "src/static-admission.ts",
    "/** Adds one. */\nexport const add = (n: number) => n + 1;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// Note.\n// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [1],
  ],
  ["src/static-admission.ts", "export const a = 1; // trailing narration", [1]],
  [
    "src/static-admission.ts",
    "// Note.\n// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [1],
  ],
  ["src/static-admission.ts", "// SAFETY:\nconst x = y as Foo;", [1]],
  [
    "src/static-admission.ts",
    "// SAFETY: nothing here is cast.\nconst x = y;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: a const assertion needs no proof.\nconst x = y as const;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: a blank line detaches this from the cast.\n\nconst x = y as Foo;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "const a = 1; // SAFETY: trailing the previous line.\nconst x = y as Foo;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the cast is two statements down.\nconst a = 1;\nconst x = y as Foo;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// platform: lower case is not the marker\nexport const a = 1;",
    [1],
  ],
  [
    "src/static-admission.ts",
    "// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// Interface: a host passes the descriptor\n// to contractFor.\nexport const a = 1;",
    [],
  ],
  [
    "tests/doctor.test.ts",
    "// The accepted\n// decision N4a keeps the line on stdout.\nexport const a = 1;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [],
  ],
  [
    "src/static-admission.ts",
    "export function f(y: unknown) {\n  // SAFETY: the caller passes a Foo.\n  return y as Foo;\n}",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the parser checked the shape.\nexport const x = y as Foo;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the parser checked the shape,\n// so every key is present.\nconst x = y as Foo;",
    [],
  ],
  [
    "src/static-admission.ts",
    "// SAFETY: the cast sits in the second argument.\nconsole.log(1, y as Foo);",
    [],
  ],
  [
    "src/static-admission.ts",
    'export const text = "// not a comment";\nexport const tpl = `/* nor this */`;',
    [],
  ],
] as const;

for (const [filePath, code, lines] of commentCases)
  test(`no-comments ${lines.length > 0 ? "refuses" : "admits"} ${JSON.stringify(code)} in ${filePath}`, async () => {
    const found = await hits("no-comments", filePath, code);
    expect(found.map(({ line }) => line)).toEqual([...lines]);
    for (const { message } of found)
      expect(message).toContain(
        "Repair: say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.",
      );
  });

test("every template rule refuses a case on a template file", async () => {
  const proved = new Set<string>();
  for (const { rule, filePath, failing } of fixes)
    if ((await hits(rule, filePath, failing)).length > 0) proved.add(rule);
  for (const { rule, filePath, code } of refused)
    if ((await hits(rule, filePath, code.join("\n"))).length > 0)
      proved.add(rule);
  for (const { rule, filePath, failing } of cases)
    if ((await hits(rule, filePath, failing.join("\n"))).length > 0)
      proved.add(rule);
  for (const [filePath, code] of commentCases)
    if ((await hits("no-comments", filePath, code)).length > 0)
      proved.add("no-comments");
  expect([...proved].sort()).toEqual(templateRules.sort());
});

test("every template rule is on for a tracked template file", async () => {
  const off: string[] = [];
  for (const rule of templateRules) {
    let on = false;
    for (const path of tracked.filter((path) => !kernelPath.test(path)))
      if (await ruleOn(`repository/${rule}`, path)) {
        on = true;
        break;
      }
    if (!on) off.push(rule);
  }
  expect(off).toEqual([]);
});

test("every recorded hit names a tracked file with that rule on", async () => {
  const recorded = (await Bun.file(
    resolve(root, "eslint-suppressions.json"),
  ).json()) as Record<string, Record<string, unknown>>;
  const dead: string[] = [];
  for (const [path, rules] of Object.entries(recorded))
    for (const rule of Object.keys(rules))
      if (!tracked.includes(path) || !(await ruleOn(rule, path)))
        dead.push(`${path} ${rule}`);
  expect(dead).toEqual([]);
});
