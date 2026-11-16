import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: resolve(import.meta.dir, "..") });

async function hits(rule: string, filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === `repository/${rule}`)
    .map(({ line, message }) => ({ line, message }));
}

const cases = [
  {
    rule: "no-locale-compare",
    witness: "b456208",
    filePath: "starters/contract3/src/kernel/validation/json-equality.ts",
    failing: [
      "export const keys = (value: Record<string, unknown>) =>",
      "  Object.entries(value).sort(([left], [right]) => left.localeCompare(right));",
    ],
    passing: [
      "export const keys = (value: Record<string, unknown>) =>",
      "  Object.entries(value).sort(([left], [right]) =>",
      "    left < right ? -1 : left > right ? 1 : 0,",
      "  );",
    ],
    line: 2,
    fix: "Compare code units with < and >",
  },
  {
    rule: "no-locale-compare",
    witness: "57c8c8b",
    filePath: "src/static-admission.ts",
    failing: [
      'const collator = new Intl.Collator("sv");',
      'export const names = ["a", "b"].sort(collator.compare);',
    ],
    passing: ['export const names = ["a", "b"].sort();'],
    line: 1,
    fix: "Compare code units with < and >",
  },
  {
    rule: "no-in-operator",
    witness: "5cbff3a",
    filePath: "starters/contract3/src/kernel/validation/version.ts",
    failing: [
      "export const declared = (value: object, fields: object) =>",
      "  Object.keys(value).every((key) => key in fields);",
    ],
    passing: [
      "export const declared = (value: object, fields: object) =>",
      "  Object.keys(value).every((key) => Object.hasOwn(fields, key));",
    ],
    line: 2,
    fix: "Check own data with Object.hasOwn on a snapshot of own data",
  },
  {
    rule: "cause-literal-owner",
    witness: "e7c771c",
    filePath: "starters/contract3/src/kernel/declaration-checks.ts",
    failing: [
      "export const reserved = (causeCode: string) =>",
      '  causeCode.startsWith("INTERNAL_RESULT_") ||',
      '  causeCode === "INTERNAL_PREPARATION";',
    ],
    passing: [
      'import { reservedFallbackCause } from "./stations.ts";',
      "export const reserved = (causeCode: string) =>",
      "  reservedFallbackCause(causeCode);",
    ],
    line: 2,
    fix: "Import it from its owner: kernel/causes.ts (commonCauses), kernel/state-causes.ts (deadlineCause, internalResultCause, internalResultCode) or kernel/stations.ts (reservedFallbackCause)",
  },
  {
    rule: "cause-literal-owner",
    witness: "e7c771c",
    filePath: "starters/contract3/src/addons/state/scope.ts",
    failing: ['export const cause = "DOMAIN_DEADLINE_UNKNOWN";'],
    passing: [
      'import { commonCauses } from "../../kernel/index.ts";',
      "export const row = commonCauses.DOMAIN_DEADLINE_UNKNOWN;",
    ],
    line: 1,
    fix: "read cause data from the kernel public index (kernel/index.ts exports commonCauses)",
  },
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

test("cause-literal-owner admits the literal inside its owner module", async () => {
  expect(
    await hits(
      "cause-literal-owner",
      "starters/contract3/src/kernel/causes.ts",
      'export const code = "DOMAIN_DEADLINE_UNKNOWN";',
    ),
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
    "let t: ReturnType<typeof setTimeout> | undefined;\nconst expired = new Promise<undefined>((resolve) => {\n  t = setTimeout(() => resolve(undefined), 5);\n});\nawait Promise.race([expired]);\nclearTimeout(t);",
    undefined,
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

test("tests-no-sleep admits the spawnBounded watchdog, which clears its handle", async () => {
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
