import { expect, test } from "bun:test";
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

// Compiles the snippet in place of the file at filePath, with the
// repository's compiler options and the rest of the tree as it is.
function typeErrors(filePath: string, code: string): string[] {
  const target = resolve(root, filePath);
  const host = ts.createCompilerHost(config.options);
  host.getCurrentDirectory = () => root;
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    name === target
      ? ts.createSourceFile(name, code, language)
      : read(name, language, ...rest);
  const program = ts.createProgram({
    rootNames: [target],
    options: config.options,
    host,
    ...(previous ? { oldProgram: previous } : {}),
  });
  previous = program;
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(target))
    .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"));
}

// The fix is read from the rule's own message, so the message and this
// proof cannot drift apart.
async function fixFor(rule: string, filePath: string, failing: string) {
  const [found] = await hits(rule, filePath, failing);
  const fix = found?.message.split(" Fix: ")[1];
  if (fix === undefined) throw new Error(`No fix in ${found?.message}.`);
  return { fix, message: found?.message ?? "" };
}

const fixes = [
  {
    rule: "no-locale-compare",
    filePath: "src/static-admission.ts",
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: (fix: string) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-locale-compare",
    filePath: "starters/contract3/src/kernel/validation/json-equality.ts",
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: (fix: string) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-in-operator",
    filePath: "starters/contract3/src/kernel/validation/result.ts",
    failing:
      'export const next = (value: Record<string, unknown>) => ("next" in value ? value.next : undefined);',
    fixed: (fix: string) =>
      `export const next = (value: Record<string, unknown>): unknown => {\n  ${fix}\n  return ownValue;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: "starters/contract3/src/kernel/pattern-worker.ts",
    failing: [
      "export const pattern = (value: unknown): unknown =>",
      '  typeof value === "object" && value !== null && "pattern" in value ? value.pattern : undefined;',
    ].join("\n"),
    fixed: (fix: string) =>
      [
        "export const pattern = (value: unknown): unknown => {",
        '  if (typeof value !== "object" || value === null) return undefined;',
        `  ${fix}`,
        "  return ownValue;",
        "};",
      ].join("\n"),
  },
  {
    rule: "no-in-operator",
    filePath: "starters/contract3/src/addons/approval/read.ts",
    failing:
      'export const code = (error: Error): unknown => ("code" in error ? error.code : undefined);',
    fixed: (fix: string) =>
      `export const code = (error: Error): unknown => {\n  ${fix}\n  return ownValue;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: "starters/contract3/src/kernel/validation/result.ts",
    failing: [
      "export const names = (value: object): string[] => {",
      "  const found: string[] = [];",
      "  for (const key in value) found.push(key);",
      "  return found;",
      "};",
    ].join("\n"),
    fixed: (fix: string) =>
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
    filePath: "starters/contract3/src/kernel/declaration-checks.ts",
    failing:
      'export const reserved = (causeCode: string) => causeCode === "INTERNAL_PREPARATION";',
    fixed: (fix: string) =>
      `${fix}\nexport const reserved = (causeCode: string) => causeCode === internalPreparation;`,
  },
  {
    rule: "cause-literal-owner",
    filePath: "starters/contract3/src/addons/state/scope.ts",
    failing:
      'export const needed = (codes: string[]) => codes.includes("DOMAIN_DEADLINE_UNKNOWN");',
    fixed: (fix: string) =>
      `${fix}\nexport const needed = (codes: string[]) => codes.includes(domainDeadlineUnknown);`,
  },
];

for (const item of fixes)
  test(`${item.rule}: the fix its message names compiles and lints clean in ${item.filePath}`, async () => {
    const { fix } = await fixFor(item.rule, item.filePath, item.failing);
    const fixed = item.fixed(fix);
    expect(typeErrors(item.filePath, fixed)).toEqual([]);
    expect(await messages(item.filePath, fixed)).toEqual([]);
  }, 60_000);

const refused = [
  {
    rule: "no-locale-compare",
    witness: "b456208",
    filePath: "starters/contract3/src/kernel/validation/json-equality.ts",
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
    ],
    lines: [1, 2, 3, 5],
  },
  {
    rule: "no-in-operator",
    witness: "5cbff3a",
    filePath: "starters/contract3/src/kernel/validation/version.ts",
    code: [
      "export const declared = (value: object, fields: object) =>",
      "  Object.keys(value).every((key) => key in fields);",
    ],
    lines: [2],
  },
  {
    rule: "no-in-operator",
    witness: "Reflect.has and for...in",
    filePath: "starters/contract3/src/kernel/validation/result.ts",
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
    rule: "cause-literal-owner",
    witness: "e7c771c",
    filePath: "starters/contract3/src/kernel/declaration-checks.ts",
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
    filePath: "starters/contract3/src/addons/state/scope.ts",
    code: [
      'const family = "DOMAIN";',
      'export const joined = "DOMAIN_" + "DEADLINE_UNKNOWN";',
      "export const template = `${family}_DEADLINE_UNKNOWN`;",
      'export const parts = [family, "DEADLINE", "UNKNOWN"].join("_");',
    ],
    lines: [2, 3, 4],
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
    filePath: "starters/contract3/src/kernel/lifecycle.ts",
    code: [
      "type Attached = { readonly enter: number } | { readonly delivery: string };",
      'export const delivery = (attached: Attached) => ("delivery" in attached ? attached.delivery : undefined);',
    ],
  },
  {
    rule: "no-in-operator",
    reason: "tells a data descriptor from an accessor",
    filePath: "starters/contract3/src/kernel/validation/primitives.ts",
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
    filePath: "starters/contract3/src/kernel/routing.ts",
    code: [
      'import type { commonCauses } from "./causes.ts";',
      "const refuse = (code: keyof typeof commonCauses) => code;",
      'export const refused = refuse("USAGE_INVALID_INVOCATION");',
    ],
  },
  {
    rule: "cause-literal-owner",
    reason: "is a host's own code, not a kernel code",
    filePath: "starters/contract3/src/addons/state/scope.ts",
    code: ['export const cause = "DOMAIN_STATE_CONFLICT";'],
  },
  {
    rule: "cause-literal-owner",
    reason: "is inside its owner module",
    filePath: "starters/contract3/src/kernel/causes.ts",
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
    filePath: "tests/contract3/stations.test.ts",
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
    fix: "Pass the message or the cause that the test's name gives",
  },
  {
    rule: "tests-use-test-folder",
    witness: "c0b4bf5",
    filePath: "tests/contract3/state/route.test.ts",
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
    filePath: "tests/contract3/lifecycle/harness.ts",
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
    fix: "Wait on the event the test is about",
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
    "tests/contract3/state/component.test.ts",
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
  [
    "tests-use-test-folder",
    'import { tmpdir as td2 } from "node:os";\ntd2();',
    "not tmpdir()",
  ],
  [
    "tests-use-test-folder",
    'import * as os from "node:os";\nconst { tmpdir: td } = os;\ntd();',
    "not tmpdir()",
  ],
  [
    "tests-use-test-folder",
    'import os from "os";\nos["tmpdir"]();',
    "not tmpdir()",
  ],
  [
    "tests-use-test-folder",
    'import * as os from "node:os";\nconst td = os.tmpdir;\ntd();',
    "not tmpdir()",
  ],
  [
    "tests-use-test-folder",
    'import { mkdtempSync as make } from "fs";\nmake("x");',
    "not mkdtempSync()",
  ],
  [
    "tests-use-test-folder",
    'import fsp from "node:fs/promises";\nawait fsp["mkdtemp"]("x");',
    "not mkdtemp()",
  ],
  [
    "tests-use-test-folder",
    'const { mkdtemp: make } = await import("fs/promises");\nawait make("x");',
    "not mkdtemp()",
  ],
  [
    "tests-use-test-folder",
    'const { tmpdir: td } = require("node:os");\ntd();',
    "not tmpdir()",
  ],
  [
    "tests-use-test-folder",
    'import { homedir as td } from "node:os";\ntd();',
    undefined,
  ],
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
] as const;

for (const [rule, code, fix] of bypasses)
  test(`${rule} ${fix ? "refuses" : "admits"} ${code} and names the fix`, async () => {
    const found = await hits(
      rule,
      "tests/contract3/state/component.test.ts",
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
      await Bun.file(resolve(import.meta.dir, "support/test-folder.ts")).text(),
    ),
  ).toEqual([]);
});

test("tests-no-sleep admits the spawnBounded watchdog, which resolves a named value", async () => {
  expect(
    await hits(
      "tests-no-sleep",
      "tests/contract3/kernel-repair/swarm-process.ts",
      await Bun.file(
        resolve(import.meta.dir, "contract3/kernel-repair/swarm-process.ts"),
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
    "tests/contract3/lifecycle/stop-flow.test.ts",
    sleeps.map(([line]) => line).join("\n"),
  );
  expect(found.map(({ line }) => line)).toEqual(
    sleeps.flatMap(([, refused], index) => (refused ? [index + 1] : [])),
  );
});
