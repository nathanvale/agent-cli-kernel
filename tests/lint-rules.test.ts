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

// Each fix is read from the rule's own message, so the message and this
// proof cannot drift apart.
async function fixesFor(rule: string, filePath: string, failing: string) {
  const found = await hits(rule, filePath, failing);
  if (found.length === 0) throw new Error(`No ${rule} hit in ${failing}.`);
  return found.map(({ message }) => {
    const fix = message.split(" Fix: ")[1];
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
    filePath: "starters/contract3/src/kernel/validation/json-equality.ts",
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: ([fix]: string[]) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-in-operator",
    filePath: "starters/contract3/src/kernel/validation/result.ts",
    failing:
      'export const next = (value: Record<string, unknown>) => ("next" in value ? value.next : undefined);',
    fixed: ([fix]: string[]) =>
      `export const next = (value: Record<string, unknown>): unknown => ${fix};`,
  },
  {
    rule: "no-in-operator",
    filePath: "starters/contract3/src/kernel/validation/result.ts",
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
    filePath: "starters/contract3/src/kernel/pattern-worker.ts",
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
    filePath: "starters/contract3/src/addons/approval/read.ts",
    failing:
      'export const code = (error: Error): unknown => ("code" in error ? error.code : undefined);',
    fixed: ([fix]: string[]) =>
      `export const code = (error: Error): unknown => ${fix};`,
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
    filePath: "starters/contract3/src/kernel/declaration-checks.ts",
    failing:
      'export const reserved = (causeCode: string) => causeCode === "INTERNAL_PREPARATION";',
    fixed: ([fix]: string[]) =>
      `${fix}\nexport const reserved = (causeCode: string) => causeCode === internalPreparation;`,
  },
  {
    rule: "cause-literal-owner",
    filePath: "starters/contract3/src/addons/state/scope.ts",
    failing:
      'export const needed = (codes: string[]) => codes.includes("DOMAIN_DEADLINE_UNKNOWN");',
    fixed: ([fix]: string[]) =>
      `${fix}\nexport const needed = (codes: string[]) => codes.includes(domainDeadlineUnknown);`,
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
    rule: "no-in-operator",
    witness: "inherited keys",
    filePath: "starters/contract3/src/kernel/validation/result.ts",
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
    reason: "narrows a union by a declared key through Reflect.has",
    filePath: "starters/contract3/src/kernel/lifecycle.ts",
    code: [
      "type Attached = { readonly enter: number } | { readonly delivery: string };",
      'export const delivered = (attached: Attached) => Reflect.has(attached, "delivery");',
    ],
  },
  {
    rule: "no-in-operator",
    reason:
      "checks a key its type declares itself, though Object.prototype has it too",
    filePath: "starters/contract3/src/kernel/validation/result.ts",
    code: [
      'export const printable = (value: { toString(): string }) => "toString" in value;',
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
    reason: "is compared with a value typed by the owner's keys",
    filePath: "starters/contract3/src/kernel/routing.ts",
    code: [
      'import type { commonCauses } from "./causes.ts";',
      'export const unchanged = (code: keyof typeof commonCauses) => code === "SUCCESS_UNCHANGED";',
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
