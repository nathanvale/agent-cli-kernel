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
