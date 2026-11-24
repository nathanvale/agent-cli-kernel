import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const eslint = new ESLint({ cwd: root });

async function messages(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map(({ ruleId, line, message }) => ({
    ruleId,
    line,
    message,
  }));
}

async function hits(rule: string, filePath: string, code: string) {
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
  const fresh = { rootNames: [target], options: config.options, host };
  const program = ts.createProgram(
    previous ? { ...fresh, oldProgram: previous } : fresh,
  );
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

async function ownerImport(rule: string, filePath: string, failing: string) {
  const [first] = await hits(rule, filePath, failing);
  const line = / Import the owner once: (.*;) Repair: /.exec(
    first?.message ?? "",
  );
  if (line?.[1] === undefined) throw new Error(`No import in ${failing}.`);
  return line[1];
}

const fixes = [
  {
    rule: "no-locale-compare",
    filePath: "kernel/src/kernel/validation/json-equality.ts",
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: ([fix]: string[]) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-in-operator",
    filePath: "kernel/src/kernel/validation/result.ts",
    failing:
      'export const next = (value: Record<string, unknown>) => ("next" in value ? value.next : undefined);',
    fixed: ([fix]: string[]) =>
      `export const next = (value: Record<string, unknown>): unknown => ${fix};`,
  },
  {
    rule: "no-in-operator",
    filePath: "kernel/src/kernel/validation/result.ts",
    failing: [
      "export const ends = (value: Record<string, unknown>): readonly unknown[] => [",
      '  "next" in value ? value.next : undefined, "handoff" in value ? value.handoff : undefined,',
      "];",
    ].join("\n"),
    fixed: ([next, handoff]: string[]) =>
      `export const ends = (value: Record<string, unknown>): readonly unknown[] => [${next}, ${handoff}];`,
  },
  {
    rule: "no-in-operator",
    filePath: "kernel/src/kernel/input.ts",
    failing: [
      "export const job = (value: unknown): readonly unknown[] =>",
      '  typeof value === "object" && value !== null && "pattern" in value && "input" in value',
      "    ? [value.pattern, value.input]",
      "    : [];",
    ].join("\n"),
    fixed: ([pattern, input]: string[]) =>
      [
        "export const job = (value: unknown): readonly unknown[] => {",
        '  if (typeof value !== "object" || value === null) return [];',
        `  const first: unknown = ${pattern};`,
        `  const second: unknown = ${input};`,
        `  const again: unknown = ${pattern};`,
        "  return [first, second, again];",
        "};",
      ].join("\n"),
  },
  {
    rule: "no-in-operator",
    filePath: "kernel/src/kernel/validation/result.ts",
    failing:
      'export const payload = (next: () => object) => ("payload" in next() ? 1 : 0);',
    fixed: ([fix]: string[]) =>
      `export const payload = (next: () => object): unknown => {\n  ${fix}\n  return own;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: "kernel/src/kernel/validation/result.ts",
    failing:
      'export const ahead = (read: () => object) => Reflect.has(read(), "next");',
    fixed: ([fix]: string[]) =>
      `export const ahead = (read: () => object): unknown => {\n  ${fix}\n  return own;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: "kernel/src/addons/approval/read.ts",
    failing:
      'export const code = (error: Error): unknown => ("code" in error ? error.code : undefined);',
    fixed: ([fix]: string[]) =>
      `export const code = (error: Error): unknown => ${fix};`,
  },
  {
    rule: "no-in-operator",
    filePath: "kernel/src/kernel/validation/result.ts",
    failing: [
      "export const names = (value: object): string[] => {",
      "  const found: string[] = [];",
      "  for (const key in value) found.push(key);",
      "  return found;",
      "};",
    ].join("\n"),
    fixed: ([fix]: string[]) =>
      [
        "export const names = (value: object): string[] => {",
        "  const found: string[] = [];",
        `  ${fix} found.push(key);`,
        "  return found;",
        "};",
      ].join("\n"),
  },
  {
    rule: "cause-literal-owner",
    filePath: "kernel/src/kernel/declaration-checks.ts",
    failing:
      'export const reserved = (causeCode: string) => causeCode === "INTERNAL_PREPARATION";',
    fixed: ([fix]: string[], imported: string) =>
      `${imported}\nexport const reserved = (causeCode: string) => causeCode === ${fix};`,
  },
  {
    rule: "cause-literal-owner",
    filePath: "kernel/src/addons/state/scope.ts",
    failing:
      'export const needed = (codes: string[]) => codes.includes("DOMAIN_DEADLINE_UNKNOWN");',
    fixed: ([fix]: string[], imported: string) =>
      `${imported}\nexport const needed = (codes: string[]) => codes.includes(${fix});`,
  },
  {
    rule: "cause-literal-owner",
    filePath: "kernel/src/kernel/declaration-checks.ts",
    failing: [
      "export const twice = (causeCode: string) =>",
      '  causeCode === "INTERNAL_PREPARATION" || causeCode.endsWith("INTERNAL_PREPARATION");',
    ].join("\n"),
    fixed: ([first, second]: string[], imported: string) =>
      [
        imported,
        "export const twice = (causeCode: string) => {",
        `  if (causeCode === ${first}) return true;`,
        `  return causeCode.endsWith(${second});`,
        "};",
      ].join("\n"),
  },
];

for (const item of fixes)
  test(`${item.rule}: the fix its message names compiles and lints clean in ${item.filePath}`, async () => {
    const found = await fixesFor(item.rule, item.filePath, item.failing);
    const imported =
      item.rule === "cause-literal-owner"
        ? await ownerImport(item.rule, item.filePath, item.failing)
        : "";
    const fixed = item.fixed(found, imported);
    expect(typeErrors(item.filePath, fixed)).toEqual([]);
    expect(await messages(item.filePath, fixed)).toEqual([]);
  }, 60_000);

test("no-in-operator: a fix for a call operand evaluates it once, in the checked order", async () => {
  const filePath = "kernel/src/kernel/validation/result.ts";
  const [inOperator] = await fixesFor(
    "no-in-operator",
    filePath,
    "export const a = (next: () => string, value: object) => next() in value;",
  );
  const [reflected] = await fixesFor(
    "no-in-operator",
    filePath,
    'export const b = (read: () => object) => Reflect.has(read(), "next");',
  );
  expect(inOperator?.split("next()")).toHaveLength(2);
  expect(inOperator?.indexOf("const key")).toBeLessThan(
    inOperator?.indexOf("const target") ?? -1,
  );
  expect(reflected?.split("read()")).toHaveLength(2);
  expect(reflected?.indexOf("const target")).toBeLessThan(
    reflected?.indexOf("const key") ?? -1,
  );
});

const refused = [
  {
    rule: "no-locale-compare",
    witness: "b456208",
    filePath: "kernel/src/kernel/validation/json-equality.ts",
    code: [
      "export const keys = (value: Record<string, unknown>) =>",
      "  Object.entries(value).sort(([left], [right]) => left.localeCompare(right));",
    ],
    lines: [2],
  },
  {
    rule: "no-in-operator",
    witness: "5cbff3a",
    filePath: "kernel/src/kernel/validation/version.ts",
    code: [
      "export const declared = (value: object, fields: object) =>",
      "  Object.keys(value).every((key) => key in fields);",
    ],
    lines: [2],
  },
  {
    rule: "no-in-operator",
    witness: "Reflect.has and for...in",
    filePath: "kernel/src/kernel/validation/result.ts",
    code: [
      'export const has = (value: object) => Reflect.has(value, "next");',
      "export const names = (value: object): string[] => {",
      "  const found: string[] = [];",
      "  for (const key in value) found.push(key);",
      "  return found;",
      "};",
    ],
    lines: [1, 4],
  },
  {
    rule: "no-in-operator",
    witness: "inherited keys",
    filePath: "kernel/src/kernel/validation/result.ts",
    code: [
      'export const built = (value: Record<string, unknown>) => "constructor" in value;',
      'export const printed = (value: unknown) => typeof value === "object" && value !== null && "toString" in value;',
      'export const owned = (value: Record<string, unknown>) => Reflect.has(value, "hasOwnProperty");',
      'export const callable = (value: () => void) => "call" in value;',
    ],
    lines: [1, 2, 3, 4],
  },
  {
    rule: "cause-literal-owner",
    witness: "e7c771c",
    filePath: "kernel/src/kernel/declaration-checks.ts",
    code: [
      "export const reserved = (causeCode: string) =>",
      '  causeCode.startsWith("INTERNAL_RESULT_") ||',
      '  causeCode === "INTERNAL_PREPARATION";',
    ],
    lines: [3],
  },
  {
    rule: "cause-literal-owner",
    witness: "codes built from parts",
    filePath: "kernel/src/addons/state/scope.ts",
    code: [
      'const family = "DOMAIN";',
      'export const joined = "DOMAIN_" + "DEADLINE_UNKNOWN";',
      "export const template = `${family}_DEADLINE_UNKNOWN`;",
      'export const parts = [family, "DEADLINE", "UNKNOWN"].join("_");',
    ],
    lines: [2, 3, 4],
  },
  {
    rule: "cause-literal-owner",
    witness: "local literal union",
    filePath: "kernel/src/kernel/routing.ts",
    code: [
      'type LocalCode = "INTERNAL_PREPARATION";',
      'export const code: LocalCode = "INTERNAL_PREPARATION";',
      'export const same = (local: LocalCode) => local === "INTERNAL_PREPARATION";',
    ],
    lines: [2, 3],
  },
];

for (const item of refused)
  test(`${item.rule} refuses the ${item.witness} shape in ${item.filePath}`, async () => {
    const found = await hits(item.rule, item.filePath, item.code.join("\n"));
    expect(found.map(({ line }) => line)).toEqual(item.lines);
  });

const admitted = [
  {
    rule: "no-in-operator",
    reason: "narrows a union by a key one member declares",
    filePath: "kernel/src/kernel/lifecycle.ts",
    code: [
      "type Attached = { readonly enter: number } | { readonly delivery: string };",
      'export const delivery = (attached: Attached) => ("delivery" in attached ? attached.delivery : undefined);',
    ],
  },
  {
    rule: "no-in-operator",
    reason: "narrows a union by a declared key through Reflect.has",
    filePath: "kernel/src/kernel/lifecycle.ts",
    code: [
      "type Attached = { readonly enter: number } | { readonly delivery: string };",
      'export const delivered = (attached: Attached) => Reflect.has(attached, "delivery");',
    ],
  },
  {
    rule: "no-in-operator",
    reason:
      "checks a key its type declares itself, though Object.prototype has it too",
    filePath: "kernel/src/kernel/validation/result.ts",
    code: [
      'export const printable = (value: { toString(): string }) => "toString" in value;',
    ],
  },
  {
    rule: "no-in-operator",
    reason:
      "checks a key its type declares itself, though the default library declares it too",
    filePath: "kernel/src/kernel/validation/result.ts",
    code: [
      'export const shown = (value: { toString(): string } & object & Object) => "toString" in value;',
    ],
  },
  {
    rule: "no-in-operator",
    reason: "checks a key a module-local interface named Function declares",
    filePath: "kernel/src/kernel/validation/result.ts",
    code: [
      "interface Function { readonly kind: string }",
      'export const kinded = (value: Function) => "kind" in value;',
    ],
  },
  {
    rule: "no-in-operator",
    reason: "checks a numeric key its type declares",
    filePath: "kernel/src/kernel/validation/result.ts",
    code: [
      "export const first = (value: { 0: string }) => 0 in value;",
      "export const reflected = (value: { 0: string }) => Reflect.has(value, 0);",
    ],
  },
  {
    rule: "no-in-operator",
    reason: "checks a unique-symbol key its type declares",
    filePath: "kernel/src/kernel/validation/result.ts",
    code: [
      'const tag: unique symbol = Symbol("tag");',
      "export const tagged = (value: { [tag]: string }) => tag in value;",
      "export const reflected = (value: { [tag]: string }) => Reflect.has(value, tag);",
    ],
  },
  {
    rule: "no-in-operator",
    reason: "tells a data descriptor from an accessor",
    filePath: "kernel/src/kernel/validation/primitives.ts",
    code: [
      "export const data = (value: object, key: string) => {",
      "  const descriptor = Object.getOwnPropertyDescriptor(value, key);",
      '  return descriptor !== undefined && "value" in descriptor;',
      "};",
    ],
  },
  {
    rule: "cause-literal-owner",
    reason: "is checked by the compiler against the owner's keys",
    filePath: "kernel/src/kernel/routing.ts",
    code: [
      'import type { commonCauses } from "./causes.ts";',
      "const refuse = (code: keyof typeof commonCauses) => code;",
      'export const refused = refuse("USAGE_INVALID_INVOCATION");',
    ],
  },
  {
    rule: "cause-literal-owner",
    reason: "is compared with a value typed by the owner's keys",
    filePath: "kernel/src/kernel/routing.ts",
    code: [
      'import type { commonCauses } from "./causes.ts";',
      'export const unchanged = (code: keyof typeof commonCauses) => code === "SUCCESS_UNCHANGED";',
    ],
  },
  {
    rule: "cause-literal-owner",
    reason: "is a host's own code, not a kernel code",
    filePath: "kernel/src/addons/state/scope.ts",
    code: ['export const cause = "DOMAIN_STATE_CONFLICT";'],
  },
  {
    rule: "cause-literal-owner",
    reason: "is inside its owner module",
    filePath: "kernel/src/kernel/causes.ts",
    code: ['export const code = "DOMAIN_DEADLINE_UNKNOWN";'],
  },
];

for (const item of admitted)
  test(`${item.rule} admits a value that ${item.reason}`, async () => {
    expect(await hits(item.rule, item.filePath, item.code.join("\n"))).toEqual(
      [],
    );
  });

const cases = [
  {
    rule: "require-to-throw-message",
    witness: "185c90d",
    filePath: "tests/kernel/stations.test.ts",
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
    filePath: "tests/kernel/state/route.test.ts",
    failing: [
      'import { mkdtempSync, realpathSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      "export const folder = () =>",
      '  realpathSync.native(mkdtempSync(join(tmpdir(), "c3-route-")));',
    ],
    passing: [
      'import { testFolder } from "../../support/test-folder.ts";',
      'export const folder = () => testFolder("c3-route-");',
    ],
    line: 5,
    fix: "testFolder(prefix) from tests/support/test-folder.ts",
  },
  {
    rule: "tests-no-sleep",
    witness: "d1436c0",
    filePath: "tests/kernel/lifecycle/harness.ts",
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
    rule: "tests-use-bounded-runner",
    witness: "9086c3b",
    filePath: "tests/kernel/state/journal.test.ts",
    failing: [
      'export const run = () => Bun.spawn([process.execPath, "reader.ts"], { stdout: "pipe" });',
    ],
    passing: [
      'import { spawnBounded } from "../kernel-repair/swarm-process.ts";',
      'export const run = () => spawnBounded([process.execPath, "reader.ts"]);',
    ],
    line: 1,
    fix: "Repair: run children through spawnBounded from tests/support/process.ts (template tests) or tests/kernel/kernel-repair/swarm-process.ts, or exitWithin from tests/kernel/lifecycle/harness.ts (kernel tests).",
  },
  {
    rule: "tests-stub-tools",
    witness: "5f0c1d9",
    filePath: "tests/kernel/state/state-addon.test.ts",
    failing: [
      'import { symlinkSync } from "node:fs";',
      'export const fake = (path: string) => symlinkSync("/bin/sh", path);',
    ],
    passing: [
      'import { writeFileSync } from "node:fs";',
      'export const fake = (path: string) => writeFileSync(path, "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });',
    ],
    line: 2,
    fix: "Repair: write an executable #!/bin/sh stub script with writeFileSync(..., { mode: 0o755 }) instead.",
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
    "tests/kernel/state/state-addon.test.ts",
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
    "tests-use-bounded-runner",
    'Bun.spawnSync(["git", "status"]);',
    "Bun.spawnSync() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'import cp = require("node:child_process");\ncp.spawnSync("git", ["status"]);',
    "child_process.spawnSync() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'Bun["spawn"](["git", "status"]);',
    "Bun.spawn() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'Bun[`spawn`](["git", "status"]);',
    "Bun.spawn() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'const { [`spawn`]: run } = Bun;\nrun(["git", "status"]);',
    "Bun.spawn() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'globalThis.Bun.spawn(["git", "status"]);',
    "Bun.spawn() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'const { Bun: runtime } = globalThis;\nruntime.spawnSync(["git", "status"]);',
    "Bun.spawnSync() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'import { default as cp } from "node:child_process";\ncp.exec("git");',
    "child_process.exec() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'const { default: cp } = await import("node:child_process");\ncp.spawn("git");',
    "child_process.spawn() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'const { spawn: run } = Bun;\nrun(["git", "status"]);',
    "Bun.spawn() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'import { execFileSync as run } from "node:child_process";\nrun("git", ["status"]);',
    "child_process.execFileSync() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'import * as cp from "child_process";\ncp["spawn"]("git", ["status"]);',
    "child_process.spawn() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'const { execSync: run } = await import("node:child_process");\nrun("git status");',
    "child_process.execSync() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'const { fork } = require("child_process");\nfork("worker.js");',
    "child_process.fork() starts a child process outside a bounded runner",
  ],
  [
    "tests-use-bounded-runner",
    'const Bun = { spawn: (args: string[]) => args };\nBun.spawn(["git"]);',
    undefined,
  ],
  [
    "tests-use-bounded-runner",
    'const spawn = (args: string[]) => args;\nspawn(["git"]);',
    undefined,
  ],
  [
    "tests-stub-tools",
    'import { symlinkSync } from "node:fs";\nsymlinkSync("/bin/sh", "node_modules/.bin/fallow");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    "tests-stub-tools",
    'import { symlink as makeLink } from "node:fs/promises";\nawait makeLink("/usr/bin/env", "node_modules/.bin/tsc");',
    'fs/promises.symlink() links or copies system binary "/usr/bin/env"',
  ],
  [
    "tests-stub-tools",
    'import * as fs from "fs";\nfs["copyFileSync"]("/bin/echo", "node_modules/.bin/tsc");',
    'fs.copyFileSync() links or copies system binary "/bin/echo"',
  ],
  [
    "tests-stub-tools",
    'import { linkSync } from "node:fs";\nconst target = `/usr/local/bin/tool`;\nlinkSync(target, "node_modules/.bin/tool");',
    'fs.linkSync() links or copies system binary "/usr/local/bin/tool"',
  ],
  [
    "tests-stub-tools",
    'const { symlinkSync } = require("node:fs");\nsymlinkSync("/sbin/nologin", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/sbin/nologin"',
  ],
  [
    "tests-stub-tools",
    'const { copyFile } = await import("fs/promises");\nawait copyFile("/bin/sh", "bin/tool");',
    'fs/promises.copyFile() links or copies system binary "/bin/sh"',
  ],
  [
    "tests-stub-tools",
    'import fs from "node:fs";\nfs.symlinkSync("/usr/sbin/tool", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/usr/sbin/tool"',
  ],
  [
    "tests-stub-tools",
    'import fs from "node:fs";\nconst { symlinkSync } = fs;\nsymlinkSync("/usr/local/sbin/tool", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/usr/local/sbin/tool"',
  ],
  [
    "tests-stub-tools",
    'import fs from "node:fs";\nawait fs.promises.symlink("/bin/sh", "bin/tool");',
    'fs/promises.symlink() links or copies system binary "/bin/sh"',
  ],
  [
    "tests-stub-tools",
    'import { promises as fsp } from "node:fs";\nawait fsp.link("/bin/sh", "bin/tool");',
    'fs/promises.link() links or copies system binary "/bin/sh"',
  ],
  [
    "tests-stub-tools",
    'const { default: fs } = await import("node:fs");\nfs.symlinkSync("/bin/sh", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    "tests-stub-tools",
    'import * as fs from "fs";\nfs[`copyFileSync`]("/bin/echo", "bin/tool");',
    'fs.copyFileSync() links or copies system binary "/bin/echo"',
  ],
  [
    "tests-stub-tools",
    'import * as fs from "fs";\nconst method = "copyFileSync";\nfs[method]("/bin/echo", "bin/tool");',
    'fs.copyFileSync() links or copies system binary "/bin/echo"',
  ],
  [
    "tests-stub-tools",
    'import * as fs from "fs";\nconst { [`symlinkSync`]: s } = fs;\ns("/bin/sh", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    "tests-stub-tools",
    'const { symlinkSync } = require(`node:fs`);\nsymlinkSync("/bin/" + "sh", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "/bin/sh"',
  ],
  [
    "tests-stub-tools",
    'const { copyFile } = await import(`fs/promises`);\nconst dir = "/usr/bin";\nawait copyFile(`${dir}/env`, "bin/tool");',
    'fs/promises.copyFile() links or copies system binary "/usr/bin/env"',
  ],
  [
    "tests-stub-tools",
    'import { symlinkSync } from "node:fs";\nsymlinkSync("//usr/./bin/env", "bin/tool");',
    'fs.symlinkSync() links or copies system binary "//usr/./bin/env"',
  ],
  [
    "tests-stub-tools",
    'import { symlinkSync } from "node:fs";\nsymlinkSync("./fixture.sh", "node_modules/.bin/tool");',
    undefined,
  ],
  [
    "tests-stub-tools",
    'import { symlinkSync } from "node:fs";\n{ const symlinkSync = (src: string, dst: string) => [src, dst]; symlinkSync("/bin/sh", "bin/tool"); }',
    undefined,
  ],
  [
    "tests-stub-tools",
    'import { symlinkSync } from "node:fs";\nconst target = "/bin/sh";\nexport const run = (target: string) => symlinkSync(target, "bin/tool");',
    undefined,
  ],
] as const;

for (const [rule, code, fix] of bypasses)
  test(`${rule} ${fix ? "refuses" : "admits"} ${code} and names the fix`, async () => {
    const found = await hits(
      rule,
      "tests/kernel/state/state-addon.test.ts",
      code,
    );
    expect(
      found.map(({ message }) => fix !== undefined && message.includes(fix)),
    ).toEqual(fix ? [true] : []);
  });

test("tests-use-test-folder admits the folder calls inside its owner module", async () => {
  expect(
    await hits(
      "tests-use-test-folder",
      "tests/support/test-folder.ts",
      await Bun.file(resolve(root, "tests/support/test-folder.ts")).text(),
    ),
  ).toEqual([]);
});

test.each([
  "tests/support/process.ts",
  "tests/kernel/kernel-repair/swarm-process.ts",
  "tests/kernel/lifecycle/harness.ts",
])(
  "tests-use-bounded-runner admits direct spawns inside owner module %s",
  async (owner) => {
    expect(
      await hits(
        "tests-use-bounded-runner",
        owner,
        await Bun.file(resolve(root, owner)).text(),
      ),
    ).toEqual([]);
  },
);

test("tests-no-sleep admits the spawnBounded watchdog, which resolves a named value", async () => {
  expect(
    await hits(
      "tests-no-sleep",
      "tests/kernel/kernel-repair/swarm-process.ts",
      await Bun.file(
        resolve(import.meta.dir, "kernel-repair/swarm-process.ts"),
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
    "tests/kernel/lifecycle/stop-flow.test.ts",
    sleeps.map(([line]) => line).join("\n"),
  );
  expect(found.map(({ line }) => line)).toEqual(
    sleeps.flatMap(([, refused], index) => (refused ? [index + 1] : [])),
  );
});

const commentCases = [
  [
    "kernel/src/kernel/routing.ts",
    "// Loop over the names.\nexport const a = 1;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// A workaround until the parser is fixed:\n// it drops the last token.\nexport const a = 1;",
    [1],
  ],
  [
    "tests/kernel/state/state-addon.test.ts",
    "/* Narration */ export const a = 1;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "/** Adds one. */\nexport const add = (n: number) => n + 1;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// Note.\n// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "export const a = 1; // trailing narration",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// Note.\n// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [1],
  ],
  ["kernel/src/kernel/routing.ts", "// SAFETY:\nconst x = y as Foo;", [1]],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: nothing here is cast.\nconst x = y;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: a const assertion needs no proof.\nconst x = y as const;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: a blank line detaches this from the cast.\n\nconst x = y as Foo;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "const a = 1; // SAFETY: trailing the previous line.\nconst x = y as Foo;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: the cast is two statements down.\nconst a = 1;\nconst x = y as Foo;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// platform: lower case is not the marker\nexport const a = 1;",
    [1],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// Interface: a host passes the descriptor\n// to contractFor.\nexport const a = 1;",
    [],
  ],
  [
    "tests/kernel/state/state-addon.test.ts",
    "// The accepted\n// decision N4a keeps the line on stdout.\nexport const a = 1;",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "export function f(y: unknown) {\n  // SAFETY: the caller passes a Foo.\n  return y as Foo;\n}",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: the parser checked the shape.\nexport const x = y as Foo;",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: the parser checked the shape,\n// so every key is present.\nconst x = y as Foo;",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
    "// SAFETY: the cast sits in the second argument.\nconsole.log(1, y as Foo);",
    [],
  ],
  [
    "kernel/src/kernel/routing.ts",
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

const fullCommentMessage =
  "A comment reads as permission, and the next agent builds on it. Keep a comment only when its first word is Platform: (behaviour of a runtime, operating system or tool this repository cannot change) or Interface: (a public contract the types cannot state), or when it cites an accepted decision (AGENTS.md, Authority), or when it opens with SAFETY: and a justification, on its own lines directly above the statement that holds a type cast (as T, not as const). Repair: say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.";

const refusedDirectiveLookalikes = [
  "// global state is fine here: menu runs one at a time.\n// TODO remove the cast once the adapter types land.\nexport const a = 1;",
  "// global state is fine here.\nexport const a = 1;",
  "// globals are shared here.\nexport const a = 1;",
  "// exported from index.\nexport const a = 1;",
  "// eslint is strict here.\nexport const a = 1;",
  "// eslint-disable TODO smuggled prose\nexport const a = 1;",
  "// eslint-enable TODO smuggled prose\nexport const a = 1;",
  "// eslint-foo bar\nexport const a = 1;",
  "// eslint-disable-foo bar\nexport const a = 1;",
  "// @ts-foo bar\nexport const a = 1;",
  "// @ts-expect-errors bar\nexport const a = 1;",
  "// biome-ignore-foo bar\nexport const a = 1;",
  "// fallow-ignore-foo bar\nexport const a = 1;",
  "// @ts-expect-error: bad type\n// TODO remove this cast\nexport const a = 1;",
  "// eslint-disable-next-line no-console\n// TODO remove this\nexport const a = 1;",
  "// biome-ignore format: keep table aligned\n// TODO clean up\nexport const a = 1;",
  "// fallow-ignore-next-line unused-export -- kept for api\n// TODO clean up\nexport const a = 1;",
  "/* @ts-expect-error: bad type\n   TODO remove this */\nexport const a = 1;",
  "/* biome-ignore format: keep table\u2028TODO remove this cast */\nexport const a = 1;",
  "/* biome-ignore format: keep table\u2029TODO remove this cast */\nexport const a = 1;",
  "/* fallow-ignore-next-line is how you hide a finding. */\nexport const a = 1;",
  "// fallow-ignore-next-line is how you hide a finding.\nexport const a = 1;",
  "// fallow-ignore unused-export\nexport const a = 1;",
  "// fallow-ignore-next-line unused -- kept for api\nexport const a = 1;",
  "/* @ts-nocheck prose */\nexport const a = 1;",
  "/* @ts-check prose */\nexport const a = 1;",
  "/* @ts-nocheck */\nexport const a = 1;",
  "/* @ts-check */\nexport const a = 1;",
  "// @ts-nocheck prose\nexport const a = 1;",
  "// @ts-check prose\nexport const a = 1;",
  "// biome-ignore format\nexport const a = 1;",
  "// biome-ignore prose without colon\nexport const a = 1;",
  "// biome-ignore-all foo: reason\nexport const a = 1;",
  "/* eslint-disable TODO smuggled prose */\nexport const a = 1;",
  "/* global state is fine here. */\nexport const a = 1;",
  "/* exported from index. */\nexport const a = 1;",
  "/* eslint is strict here. */\nexport const a = 1;",
  "// eslint-disable\nexport const a = 1;",
  "// eslint-enable\nexport const a = 1;",
  "// eslint no-console: off\nexport const a = 1;",
  "// global foo\nexport const a = 1;",
  "// globals foo\nexport const a = 1;",
  "// exported a\nexport const a = 1;",
  "/* globals */\nexport const a = 1;",
  "/* exported */\nexport const a = 1;",
  "export const a = 1; /* fallow-ignore-file -- prose */",
  "/* fallow-ignore-file -- prose */ export const b = 1;",
  "export const a = 1; /* fallow-ignore-next-line unused-export -- prose */",
  "/* fallow-ignore-next-line unused-export -- prose */ export const b = 1;",
  "// biome-ignore lint/remove/thisCast: prose must not become permission\nexport const a = 1;",
  "// biome-ignore lint/fakeGroup: prose\nexport const a = 1;",
  "// biome-ignore lint/style/fakeRule: prose\nexport const a = 1;",
  "// biome-ignore assist/source: prose\nexport const a = 1;",
  "// biome-ignore assist/source/fakeAction: prose\nexport const a = 1;",
] as const;

const admittedDirectives = [
  "// @ts-expect-error -- lock test\nexport const a = 1;",
  "// @ts-expect-error: lock test\nexport const a = 1;",
  "// @ts-ignore reason\nexport const a = 1;",
  "// @ts-nocheck\nexport const a = 1;",
  "// @ts-check\nexport const a = 1;",
  "// biome-ignore format: keep table\nexport const a = 1;",
  "// biome-ignore lint/style/useConst: keep binding mutable\nexport const a = 1;",
  "// biome-ignore assist/source/organizeImports: preserve order\nexport const a = 1;",
  "// fallow-ignore-next-line unused-export -- kept for api\nexport const a = 1;",
  "// fallow-ignore-file unused-export -- kept for api\nexport const a = 1;",
  "/* fallow-ignore-file unused-export -- kept for api */\nexport const a = 1;",
  "  /* fallow-ignore-next-line unused-export -- kept for api */\nexport const a = 1;",
  "// eslint-disable-next-line no-console\nexport const a = 1;",
  "// eslint-disable-next-line @typescript-eslint/consistent-type-assertions\nexport const a = 1;",
  "export const a = 1; // eslint-disable-line no-console",
  "/* eslint-disable */\nexport const a = 1;",
  "/* eslint-enable */\nexport const a = 1;",
  "/* eslint no-console: off */\nexport const a = 1;",
  "/* global foo */\nexport const a = 1;",
  "/* globals foo */\nexport const a = 1;",
  "/* exported a */\nexport const a = 1;",
] as const;

test("no-comments refuses directive-lookalike prose and trailing lines in kernel files, and admits exact directives", async () => {
  const filePath = "kernel/src/addons/menu/index.ts";
  for (const code of refusedDirectiveLookalikes) {
    expect(await hits("no-comments", filePath, code)).toEqual([
      { line: 1, message: fullCommentMessage },
    ]);
  }
  for (const code of admittedDirectives) {
    expect(await hits("no-comments", filePath, code)).toEqual([]);
  }
});

const stateFsCases = [
  [
    "kernel/src/addons/state/install.ts",
    'import { mkdirSync } from "node:fs"; export const a = mkdirSync;',
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    'import { readFile } from "node:fs/promises"; export const a = readFile;',
    [1],
  ],
  [
    "kernel/src/addons/state/scope.ts",
    'import fs from "fs"; export const a = fs;',
    [1],
  ],
  [
    "kernel/src/addons/state/qualification.ts",
    'import * as fsp from "fs/promises"; export const a = fsp;',
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    'export { mkdirSync } from "node:fs";',
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    'export * from "node:fs/promises";',
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    'export const a = () => import("node:fs");',
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    "export const a = () => import(`node:fs/promises`);",
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    'const name = "node:" + "fs"; export const a = () => import(name);',
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    "export const a = (name: string) => import(name);",
    [1],
  ],
  [
    "kernel/src/addons/state/install.ts",
    'export const a = () => process.getBuiltinModule("node:fs");',
    [1],
  ],
  [
    "kernel/src/addons/state/store.ts",
    'import { mkdirSync } from "node:fs"; export const a = mkdirSync;',
    [],
  ],
  [
    "kernel/src/addons/state/coordination.ts",
    'import { openSync } from "node:fs"; export const a = openSync;',
    [],
  ],
  [
    "kernel/src/addons/state/install.ts",
    'import { join } from "node:path"; export const a = join;',
    [],
  ],
] as const;

for (const [filePath, code, lines] of stateFsCases)
  test(`state-no-fs-import ${lines.length > 0 ? "refuses" : "admits"} ${JSON.stringify(code)} in ${filePath}`, async () => {
    const found = await hits("state-no-fs-import", filePath, code);
    expect(found.map(({ line }) => line)).toEqual([...lines]);
  });

const runtimeGates = new Set([
  "no-console",
  "no-restricted-imports",
  "no-restricted-properties",
  "repository/no-domain-output",
  "repository/no-process-reach",
]);
const installedSource = [
  "kernel/src/addons/menu/index.ts",
  "skills/verify-cli/helper/place.ts",
];
const startMessage =
  "Contract 3 source starts programs only through the programs add-on.";
const streamMessage =
  "Return domain data to the CLI output owner instead of accessing process streams.";
const program = `repository/no-process-reach: ${startMessage}`;
const output = `repository/no-process-reach: ${streamMessage}`;
const domainOutput = `repository/no-domain-output: ${streamMessage}`;
const restricted = (name: string) =>
  `no-restricted-properties: '${name}' is restricted from being used.`;
const moduleStarRestriction =
  "no-restricted-imports: * import is invalid because 'createRequire' from 'node:module' is restricted. Code outside the kernel and the state add-on imports them through their public index only, by a literal specifier: no computed or template-literal import(), require, createRequire or import.meta.require.";
const consoleCall = "no-console: Unexpected console statement.";
const runtimeSpellings = [
  ['import { spawnSync } from "bun"; export const run = spawnSync;', program],
  ['import { $ } from "bun"; export const run = $;', program],
  ['import * as bun from "bun"; export const run = bun.spawn;', program],
  ['import bun from "bun"; export const run = bun;', program],
  ['export const run = () => import("bun");', program],
  ["export const run = () => import(`bun`);", program],
  ["export const run = globalThis.Bun.spawnSync;", program],
  ['export const run = globalThis["Bun"];', program],
  ["export const run = global.Bun;", program],
  ["const runtime = Bun; export const run = runtime.spawnSync;", program],
  ["export const run = [Bun];", program],
  ['export const run = (key: "spawn") => Bun[key];', program],
  ['export const run = Bun["spawn"];', restricted("Bun.spawn")],
  ["const { $ } = Bun; export const run = $;", restricted("Bun.$")],
  ["export const run = Bun.spawn;", restricted("Bun.spawn")],
  ['import { default as bun } from "bun"; export const run = bun;', program],
  ['export { spawnSync } from "bun";', program],
  ['export { $ } from "bun";', program],
  ['export { default as bun } from "bun";', program],
  ['export * from "bun";', program],
  ['export const run = () => import("node:child_process");', program],
  ['export const run = () => import("child_process");', program],
  ["export const run = (name: string) => import(name);", program],
  ['export const run = () => import("b" + "un");', program],
  ['export const run = import.meta.require("bun");', program],
  ['export const run = import.meta.require("node:child_process");', program],
  ['export const run = require("bun");', program],
  ["export const run = Bun.openInEditor;", program],
  [
    'export const run = process.getBuiltinModule("node:child_process");',
    output,
  ],
  ['export const out = () => Bun.write(Bun.stdout, "x");', domainOutput],
  ["const { stderr } = Bun; export const out = stderr;", domainOutput],
  ['import { stdout } from "bun"; export const out = stdout;', domainOutput],
  ["const { stdout } = process; export const out = stdout;", domainOutput],
  [
    "let out: unknown; ({ stdout: out } = process); export { out };",
    domainOutput,
  ],
  ["const { ...all } = process; export const out = all;", output],
  ['import proc from "node:process"; export const out = proc.stdout;', output],
  ['import * as proc from "process"; export const out = proc;', output],
  ['export const out = () => import("node:process");', output],
  [
    'import { stdout } from "node:process"; export const out = stdout;',
    domainOutput,
  ],
  ['export const out = process.getBuiltinModule("node:process");', output],
  ['export const out = () => globalThis.console.log("x");', output],
  ['export const out = () => globalThis.process.stderr.write("x");', output],
  ["const { process: host } = globalThis; export const out = host;", output],
  ["const scope = globalThis; export const out = scope;", output],
  ['export const out = () => process[`stdout`].write("x");', domainOutput],
  ['export const out = () => process["stderr"].write("x");', domainOutput],
  ['export const out = (key: "stdout") => process[key];', output],
  ['export const out = () => process.stdout.write("x");', domainOutput],
  ["const printer = console; export const out = printer;", output],
  ['export const out = () => console.log("x");', consoleCall],
  ["const { log } = console; export const out = log;", output],
  ["let log: unknown; ({ log } = console); export { log };", output],
  ["export const out = ({ log } = console) => log;", output],
  [
    'import { "default" as proc } from "node:process"; export const out = proc;',
    output,
  ],
  [
    'import { default as proc } from "process"; export const out = proc;',
    output,
  ],
  [
    'import { getBuiltinModule } from "node:process"; export const out = getBuiltinModule;',
    output,
  ],
  [
    "const { getBuiltinModule } = process; export const out = getBuiltinModule;",
    output,
  ],
  ['import c from "node:console"; export const out = c;', output],
  ['import { log } from "console"; export const out = log;', output],
  ['export { stdout } from "node:process";', output],
  ['export * as proc from "node:process";', output],
  ['export const out = import.meta.require("node:process");', output],
  ['export const out = () => process.emitWarning("x");', output],
  ['export const out = () => process._rawDebug("x");', output],
  [
    'export const out = () => process.on("exit", () => {}).stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.once("exit", () => {}).stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.off("exit", () => {}).stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.addListener("exit", () => {}).stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.removeListener("exit", () => {}).stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.removeAllListeners("x").stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.prependListener("exit", () => {}).stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.prependOnceListener("exit", () => {}).stdout.write("x");',
    output,
  ],
  [
    'export const out = () => process.setMaxListeners(10).stdout.write("x");',
    output,
  ],
  [
    'export const out = (stop: () => void) => process.on("SIGINT", stop);',
    output,
  ],
  [
    'export const out = () => process.on?.("exit", () => {})?.stdout.write("x");',
    output,
  ],
  [
    'export const out = (stop: () => void) => process[`on`]("SIGINT", stop);',
    output,
  ],
  ["export const out = process.on;", output],
  ["const { on } = process; export const out = on;", output],
  [
    'import { removeAllListeners } from "node:process"; export const out = () => removeAllListeners("x").stdout.write("x");',
    output,
  ],
  ['import { on } from "node:process"; export const out = on;', output],
  [
    'declare const process: typeof globalThis.process; const p = process; export const out = () => p.stdout.write("x");',
    output,
  ],
  [
    'declare const Bun: typeof globalThis.Bun; const b = Bun; export const run = () => b.spawnSync(["true"]);',
    program,
  ],
  [
    'declare const console: typeof globalThis.console; const c = console; export const out = () => c.log("x");',
    output,
  ],
  [
    'declare const console: typeof globalThis.console; export const out = () => console.log("x");',
    output,
  ],
  [
    "interface process { ok?: boolean } declare const process: typeof globalThis.process; const p = process; export const out = p;",
    output,
  ],
  [
    "declare function require(id: string): unknown; const load = require; export const run = load;",
    program,
  ],
  ["export const run = globalThis.require;", program],
  ['import "bun";', program],
  ['import { stdout } from "node:module"; export const out = stdout;', program],
  ['const load = require; export const run = () => load("bun");', program],
  [
    "const load: (id: string) => unknown = require; export const run = load;",
    program,
  ],
  ['export const run = () => (0, require)("bun");', program],
  [
    'const load = import.meta.require; export const run = () => load("node:child_process");',
    program,
  ],
  ['export const run = (k: "require") => import.meta[k]("bun");', program],
  ['export const run = () => import.meta["require"]("bun");', program],
  ['export const run = () => import.meta[`require`]("bun");', program],
  ["const { require: load } = import.meta; export const run = load;", program],
  [
    'const { "require": load } = import.meta; export const run = load;',
    program,
  ],
  ["const { ...meta } = import.meta; export const run = meta;", program],
  ["const meta = import.meta; export const run = meta;", program],
  ["export const run = () => require(0);", program],
  [
    'import mod from "node:module"; export const run = () => mod.createRequire(import.meta.url)("node:child_process");',
    program,
  ],
  ['import { Module } from "node:module"; export const run = Module;', program],
  ['import { Module } from "module"; export const run = Module;', program],
  [
    'import * as mod from "node:module"; export const run = mod;',
    [program, moduleStarRestriction],
  ],
  ['import "node:module";', program],
  ['export { Module } from "node:module";', program],
  ['export * from "node:module";', [program, moduleStarRestriction]],
  ['export type { NodeModule } from "node:module";', program],
  ['export const run = async () => import("node:module");', program],
  ['export const run = async () => import("module");', program],
  ['export const run = () => require("node:module");', program],
  ['export const run = () => import.meta.require("node:module");', program],
  ["for (Bun; false; ) { break; }", program],
] as const;
const honestRuntime = [
  'import type { Subprocess } from "bun"; export type Child = Subprocess;',
  'import { type Subprocess } from "bun"; export type Child = Subprocess;',
  "export const read = (path: string) => Bun.file(path).text();",
  'export const home = () => process.env["HOME"];',
  "const { argv } = process; export const args = argv;",
  "export const tag = { process: 1, Bun: 2, console: 3 };",
  "export type Spawn = typeof Bun.spawn;",
  "export const kind = typeof process;",
  "export const later = globalThis.setTimeout;",
  'import type { stdout } from "bun"; export type Out = typeof stdout;',
  'import { type stdout } from "node:process"; export type Out = typeof stdout;',
  "export const flag = () => process.env.X;",
  "export const args = () => process.argv;",
  'export const read = () => Bun.file("x");',
  'import { file } from "bun"; export const read = file;',
  'import { env } from "node:process"; export const read = env;',
  'export const path = () => import("node:path");',
  'export const listen = (stop: () => void) => { process.on("SIGINT", stop); };',
  'export const listenOpt = (stop: () => void) => { process.on?.("SIGINT", stop); };',
  'export const listenVoid = (stop: () => void) => void process.on("SIGINT", stop);',
  'export const unlisten = (stop: () => void) => { process.off("SIGWINCH", stop); };',
  "export const metaUrl = import.meta.url;",
  "const { url } = import.meta; export const metaUrlDestructured = url;",
  "export const localRequire = () => { const require = (ok: boolean) => ok; return require(true); };",
  'import type { NodeModule } from "node:module"; export type Mod = NodeModule;',
  'import { type NodeModule } from "module"; export type Mod = NodeModule;',
  "export const shadowed = (process: { env: string }) => process;",
];

async function runtimeHits(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter(({ ruleId }) => runtimeGates.has(String(ruleId)))
    .map(({ ruleId, message }) => `${ruleId}: ${message}`);
}

const runtimeLintBound = 60_000;

for (const filePath of installedSource)
  test(
    `the kernel lint refuses each spelling of a program start or a process stream once in ${filePath}, and admits honest runtime use`,
    async () => {
      const found = [];
      for (const [code] of runtimeSpellings)
        found.push([code, await runtimeHits(filePath, code)]);
      expect(found).toEqual(
        runtimeSpellings.map(([code, hit]) => [
          code,
          typeof hit === "string" ? [hit] : [...hit],
        ]),
      );
      for (const code of honestRuntime)
        expect(await runtimeHits(filePath, code)).toEqual([]);
    },
    runtimeLintBound,
  );

const scriptForms = ["js", "mjs", "cjs", "jsx", "tsx"];

for (const typed of installedSource)
  test(`the kernel lint refuses source beside ${typed} that is not TypeScript, and admits .ts`, async () => {
    const folder = typed.slice(0, typed.lastIndexOf("/"));
    const code = 'export const word = "menu";';
    const refused = [];
    for (const form of scriptForms)
      refused.push(
        await hits("typescript-source", `${folder}/word.${form}`, code),
      );
    expect(refused).toEqual(
      scriptForms.map(() => [
        {
          line: 1,
          message:
            "Source is TypeScript (.ts, .mts or .cts). Repair: write this file as .ts, .mts or .cts.",
        },
      ]),
    );
    expect(await hits("typescript-source", typed, code)).toEqual([]);
  });

const framingFile = "kernel/src/addons/state/framing.ts";
const stateFiles =
  "Files in kernel/src/addons/state outside store.ts and coordination.ts";
const member = (line: number, name: string) =>
  [
    line,
    `${stateFiles} must not use Bun.${name}: only Bun members that touch no path are allowed here. Repair: route filesystem access through store.ts (using WriteGate for writes) or coordination.ts.`,
  ] as const;
const use = (line: number) =>
  [
    line,
    `${stateFiles} may use the Bun object only as Bun.<member> with a plain member name, read from Bun, globalThis.Bun, global.Bun or self.Bun, or as a named import from "bun". An alias, destructuring, spread, computed key, whole-module load of "bun", or bare globalThis, global or self hides which member is used. Repair: write Bun.<member> in place, or route filesystem access through store.ts or coordination.ts.`,
  ] as const;
const filesystemImport = (line: number, specifier: string) =>
  [
    line,
    `${stateFiles} must not import filesystem module "${specifier}". Repair: route filesystem access through store.ts (using WriteGate for writes) or coordination.ts.`,
  ] as const;
const aliasChain = Array.from(
  { length: 10 },
  (_, index) => `const b${index + 1} = ${index === 0 ? "Bun" : `b${index}`};`,
).join(" ");
const loader = (line: number) =>
  [
    line,
    `${stateFiles} may load a module only by a static import, or by calling require, import.meta.require or process.getBuiltinModule directly with a string, and may use process and import.meta only as process.<member> and import.meta.<member>. An alias, a computed key, createRequire, module, or a whole import of "node:module" or "node:process" hides which module is loaded. Repair: write a static import.`,
  ] as const;
const stateBunFileReachCases = [
  [
    framingFile,
    "export const a = (p: string) => Bun.file(p);",
    [member(1, "file")],
  ],
  [
    framingFile,
    'export const a = (p: string) => Bun.write(p, "x");',
    [member(1, "write")],
  ],
  [framingFile, "import f = Bun.file; export const a = f;", [use(1)]],
  [framingFile, "import b = globalThis.Bun; export const a = b;", [use(1)]],
  [
    framingFile,
    "export const a = (p: string) => Bun.mmap(p);",
    [member(1, "mmap")],
  ],
  [framingFile, 'export const a = new Bun.Glob("*");', [member(1, "Glob")]],
  [framingFile, "export const a = Bun.Archive;", [member(1, "Archive")]],
  [framingFile, "export const a = Bun.build;", [member(1, "build")]],
  [
    framingFile,
    "export const a = Bun.FileSystemRouter;",
    [member(1, "FileSystemRouter")],
  ],
  [
    framingFile,
    "export const a = [Bun.SQL, Bun.sql];",
    [member(1, "SQL"), member(1, "sql")],
  ],
  [
    framingFile,
    "export const a = [Bun.Image, Bun.postgres];",
    [member(1, "Image"), member(1, "postgres")],
  ],
  [
    framingFile,
    "export const a = [Bun.ModuleGraph, Bun.serve];",
    [member(1, "ModuleGraph"), member(1, "serve")],
  ],
  [
    framingFile,
    "export const a = (p: string) => globalThis.Bun.file(p);",
    [member(1, "file")],
  ],
  [
    framingFile,
    "export const a = (p: string) => global.Bun.file(p);",
    [member(1, "file")],
  ],
  [
    framingFile,
    "export const a = (p: string) => self.Bun.file(p);",
    [member(1, "file")],
  ],
  [
    framingFile,
    "export const a = globalThis.globalThis.Bun.file;",
    [member(1, "file")],
  ],
  [framingFile, 'export const a = (p: string) => Bun["file"](p);', [use(1)]],
  [
    framingFile,
    'export const a = (p: string) => Bun[`write`](p, "x");',
    [use(1)],
  ],
  [
    framingFile,
    'const key = "wr" + "ite"; export const a = Bun[key];',
    [use(1)],
  ],
  [
    framingFile,
    'export const a = (key: string) => Bun[key as "file"];',
    [use(1)],
  ],
  [
    framingFile,
    "const { file, write } = Bun; export const a = [file, write];",
    [use(1)],
  ],
  [
    framingFile,
    "const { spawnSync } = Bun; export const a = spawnSync;",
    [use(1)],
  ],
  [framingFile, "const { ...all } = Bun; export const a = all;", [use(1)]],
  [
    framingFile,
    'const b = Bun; export const a = (p: string) => b.write(p, "x");',
    [use(1)],
  ],
  [framingFile, "let b; b = Bun; export const a = b;", [use(1)]],
  [
    framingFile,
    "let b = globalThis; b = Bun; export const a = b.file;",
    [use(1), use(1)],
  ],
  [
    framingFile,
    "let b; if (Date.now()) b = Bun; export const a = b;",
    [use(1)],
  ],
  [framingFile, `${aliasChain} export const a = b10.file;`, [use(1)]],
  [framingFile, "export const a = { ...Bun };", [use(1)]],
  [
    framingFile,
    "export const a = (x: boolean) => (x ? Bun : Bun).file;",
    [use(1), use(1)],
  ],
  [framingFile, "export const a = (Bun || Bun).file;", [use(1), use(1)]],
  [framingFile, "export const a = String(Bun);", [use(1)]],
  [
    framingFile,
    "const { Bun: { file } } = globalThis; export const a = file;",
    [use(1)],
  ],
  [
    framingFile,
    "const { Bun: { file } = {} } = globalThis; export const a = file;",
    [use(1)],
  ],
  [framingFile, "const g = globalThis; export const a = g.Bun.file;", [use(1)]],
  [framingFile, 'export const a = globalThis["Bun"].file;', [use(1)]],
  [
    framingFile,
    "export async function writeFrame(path: string, text: string) {\n  await Bun.write(path, text);\n  return Bun.file(path).text();\n}",
    [member(2, "write"), member(3, "file")],
  ],
  [
    framingFile,
    'import fs = require("node:fs"); export const a = fs.readFileSync;',
    [filesystemImport(1, "node:fs")],
  ],
  [
    framingFile,
    'import path = require("node:path"); export const a = path.join;',
    [],
  ],
  [
    "kernel/src/addons/state/store.ts",
    "export const a = (p: string) => Bun.write(p, Bun.file(p));",
    [],
  ],
  [
    "kernel/src/addons/state/coordination.ts",
    "const { file } = Bun; export const a = (p: string) => file(p);",
    [],
  ],
  [
    framingFile,
    'export const a = [Bun.spawn(["true"]), Bun.spawnSync, Bun.$];',
    [],
  ],
  [framingFile, "export const a = [Bun.version, Bun.hash, Bun.stdout];", []],
  [
    framingFile,
    'import { spawn, type BunFile } from "bun"; export const a = (f: BunFile) => [spawn, f];',
    [],
  ],
  [
    framingFile,
    'import type { BunFile } from "bun"; export type A = BunFile;',
    [],
  ],
  [framingFile, 'export type { BunFile } from "bun";', []],
  [framingFile, "export type A = typeof Bun.file;", []],
  [framingFile, "export const a = globalThis.structuredClone;", []],
] as const;

const stateBunImportCases = [
  [
    framingFile,
    'import { write } from "bun"; export const a = write;',
    [member(1, "write")],
  ],
  [framingFile, 'export { file } from "bun";', [member(1, "file")]],
  [framingFile, 'export const a = require("bun").file;', [use(1)]],
  [framingFile, 'export const a = import.meta.require("bun").file;', [use(1)]],
  [
    framingFile,
    'export const a = process.getBuiltinModule("bun").write;',
    [use(1)],
  ],
  [framingFile, 'import * as B from "bun"; export const a = B.file;', [use(1)]],
  [framingFile, 'import B from "bun"; export const a = B.file;', [use(1)]],
  [framingFile, 'export * from "bun";', [use(1)]],
  [
    framingFile,
    'import B = require("bun"); export const a = B.file;',
    [use(1)],
  ],
  [
    framingFile,
    'export const a = async () => (await import("bun")).write;',
    [use(1)],
  ],
  [framingFile, 'export const a = require("bun").spawn;', [use(1)]],
  [
    framingFile,
    'import { default as b } from "bun"; export const a = b;',
    [use(1)],
  ],
  [
    framingFile,
    'import { "default" as b } from "bun"; export const a = b;',
    [use(1)],
  ],
  [framingFile, 'export { default } from "bun";', [use(1)]],
  [framingFile, 'export { "default" as b } from "bun";', [use(1)]],
] as const;

const stateShadowedGlobalCases = [
  [
    framingFile,
    "export const a = (Bun: { file: string }) => Bun.file;",
    [member(1, "file")],
  ],
  [
    framingFile,
    "declare const Bun: typeof globalThis.Bun; export const a = Bun.file;",
    [member(1, "file")],
  ],
  [
    framingFile,
    "declare const global: typeof globalThis; export const a = global.Bun.file;",
    [member(1, "file")],
  ],
  [
    framingFile,
    "declare const self: typeof globalThis; export const a = self.Bun.file;",
    [member(1, "file")],
  ],
  [
    framingFile,
    "declare const globalThis: { Bun: typeof Bun }; export const a = globalThis.Bun.file;",
    [member(1, "file")],
  ],
  [framingFile, "const self = { dev: 1 }; export const a = self.dev;", []],
] as const;

const stateLoaderCases = [
  [
    framingFile,
    'export const a = globalThis.process.getBuiltinModule("bun");',
    [use(1)],
  ],
  [
    framingFile,
    'const p = process; export const a = p.getBuiltinModule("bun");',
    [loader(1)],
  ],
  [
    framingFile,
    'export const a = (k: "getBuiltinModule") => process[k]("bun");',
    [loader(1)],
  ],
  [
    framingFile,
    'export const a = (k: "require") => import.meta[k]("bun");',
    [loader(1)],
  ],
  [framingFile, 'const r = require; export const a = r("bun");', [loader(1)]],
  [framingFile, 'export const a = require.resolve("bun");', [loader(1)]],
  [framingFile, "export const a = import.meta;", [loader(1)]],
  [framingFile, 'export const a = module.require("bun");', [loader(1)]],
  [
    framingFile,
    'import { createRequire } from "node:module"; export const a = createRequire;',
    [loader(1)],
  ],
  [
    framingFile,
    'import * as m from "node:module"; export const a = m;',
    [loader(1)],
  ],
  [framingFile, 'export const a = require("node:module");', [loader(1)]],
  [
    framingFile,
    'import { getBuiltinModule } from "node:process"; export const a = getBuiltinModule;',
    [loader(1)],
  ],
  [
    framingFile,
    'import proc from "node:process"; export const a = proc.getBuiltinModule("bun");',
    [loader(1)],
  ],
  [
    framingFile,
    "export const a = [process.platform, process.pid, import.meta.url];",
    [],
  ],
  [framingFile, 'export const a = require("node:path");', []],
  [
    framingFile,
    'import { builtinModules } from "node:module"; export const a = builtinModules;',
    [loader(1)],
  ],
  [
    framingFile,
    'import { builtinModules } from "module"; export const a = builtinModules;',
    [loader(1)],
  ],
  [
    framingFile,
    'import { default as p } from "node:process"; export const a = p;',
    [loader(1)],
  ],
  [
    framingFile,
    'import { "default" as p } from "process"; export const a = p;',
    [loader(1)],
  ],
  [framingFile, 'export { default } from "node:process";', [loader(1)]],
  [framingFile, 'export { "default" as p } from "process";', [loader(1)]],
  [framingFile, 'export { default } from "node:module";', [loader(1)]],
  [framingFile, 'export { default } from "module";', [loader(1)]],
  [
    framingFile,
    'import { default as m } from "node:module"; export const a = m;',
    [loader(1)],
  ],
  [
    framingFile,
    'import { "default" as m } from "module"; export const a = m;',
    [loader(1)],
  ],
  [
    framingFile,
    'import { Module } from "node:module"; export const a = Module;',
    [loader(1)],
  ],
  [
    framingFile,
    'import { Module } from "module"; export const a = Module;',
    [loader(1)],
  ],
  [framingFile, 'export { Module } from "node:module";', [loader(1)]],
  [framingFile, 'export { Module } from "module";', [loader(1)]],
  [framingFile, 'import "node:module";', [loader(1)]],
  [framingFile, 'import {} from "module";', [loader(1)]],
  [framingFile, 'export {} from "node:module";', [loader(1)]],
  [
    framingFile,
    'import type { Module } from "node:module"; export type A = Module;',
    [],
  ],
  [
    framingFile,
    'import { type Module } from "node:module"; export type A = Module;',
    [],
  ],
  [framingFile, 'export type { Module } from "node:module";', []],
  [
    framingFile,
    'import { platform } from "node:process"; export const a = platform;',
    [],
  ],
  [framingFile, 'export { platform as default } from "node:process";', []],
] as const;

for (const [group, cases] of [
  ["Bun global", stateBunFileReachCases],
  ["bun import", stateBunImportCases],
  ["shadowed global", stateShadowedGlobalCases],
  ["loader", stateLoaderCases],
] as const)
  for (const [filePath, code, expected] of cases)
    test(`state-no-fs-import ${group} ${expected.length > 0 ? "refuses" : "admits"} ${JSON.stringify(code)} in ${filePath}`, async () => {
      const found = (await messages(filePath, code)).filter(
        ({ ruleId }) => ruleId === "repository/state-no-fs-import",
      );
      expect(found.map(({ line, message }) => [line, message])).toEqual(
        expected.map(([line, message]) => [line, message]),
      );
    });
