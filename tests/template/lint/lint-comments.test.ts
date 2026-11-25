import { expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBiomeCategories } from "../../../config/comment-directives.mjs";
import {
  commentCases,
  supportedFallowTargets,
} from "../../support/lint-comment-cases.ts";
import {
  hits,
  messages,
  templateSourceFile,
} from "../../support/template-lint.ts";
import { testFolder } from "../../support/test-folder.ts";

const fullCommentMessage =
  "A comment reads as permission, and the next agent builds on it. Keep a comment only when its first word is Platform: (behaviour of a runtime, operating system or tool this repository cannot change) or Interface: (a public contract the types cannot state), or when it cites an accepted decision (AGENTS.md, Authority), or when it opens with SAFETY: and a justification, on its own lines directly above the statement that holds a type cast (as T, not as const). Repair: say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.";

const refusedDirectiveLookalikes = [
  "// global state is fine here: resolution runs once.\n// TODO remove the cast once the adapter types land.\nexport const a = 1;",
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
  "// biome-ignore lint/style/useConst lint/style/fakeRule: prose\nexport const a = 1;",
  "// biome-ignore lint/style/useConst prose: reason\nexport const a = 1;",
  "// fallow-ignore-next-line this-is-plain-prose\nexport const a = 1;",
  "// fallow-ignore-file this-is-plain-prose\nexport const a = 1;",
  "// fallow-ignore-next-line unused-exports -- plural is not accepted\nexport const a = 1;",
  "// fallow-ignore-next-line boundary-coverage-violations -- wrong alias\nexport const a = 1;",
  "// fallow-ignore-next-line unused-export, fake-target -- mixed\nexport const a = 1;",
  "// fallow-ignore-next-line policy-violation:bad -- missing rule\nexport const a = 1;",
  "// fallow-ignore-next-line unused-export --\nexport const a = 1;",
] as const;

const admittedDirectives = [
  "// @ts-expect-error -- lock test\nexport const a = 1;",
  "// @ts-expect-error: lock test\nexport const a = 1;",
  "// @ts-ignore reason\nexport const a = 1;",
  "// @ts-nocheck\nexport const a = 1;",
  "// @ts-check\nexport const a = 1;",
  "// biome-ignore format: keep table\nexport const a = 1;",
  "// biome-ignore lint/style/useConst: keep binding mutable\nexport const a = 1;",
  "// biome-ignore lint/style/useConst lint/suspicious/noExplicitAny: reason\nexport const a = 1;",
  "// biome-ignore lint/style/useConst(foo) lint/suspicious/noExplicitAny: reason\nexport const a = 1;",
  "// biome-ignore assist/source/organizeImports: preserve order\nexport const a = 1;",
  "// fallow-ignore-next-line -- blanket reason\nexport const a = 1;",
  "// fallow-ignore-next-line complexity -- kept complex\nexport const a = 1;",
  "// fallow-ignore-file complexity -- kept complex\nexport const a = 1;",
  "// fallow-ignore-next-line unused-export, complexity -- combined\nexport const a = 1;",
  "// fallow-ignore-next-line policy-violation:pack/rule -- scoped rule\nexport const a = 1;",
  "// fallow-ignore-next-line unused-export -- kept for api\nexport const a = 1;",
  "// fallow-ignore-file unused-export -- kept for api\nexport const a = 1;",
  "/* fallow-ignore-file unused-export -- kept for api */\nexport const a = 1;",
  "  /* fallow-ignore-next-line unused-export -- kept for api */\nexport const a = 1;",
  ...supportedFallowTargets.map(
    (target) =>
      `// fallow-ignore-next-line ${target} -- supported\nexport const a = 1;`,
  ),
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

for (const [filePath, code, lines] of commentCases)
  test(`no-comments ${lines.length > 0 ? "refuses" : "admits"} ${JSON.stringify(code)} in ${filePath}`, async () => {
    const found = await hits("no-comments", filePath, code);
    expect(found.map(({ line }) => line)).toEqual([...lines]);
    for (const { message } of found)
      expect(message).toContain(
        "Repair: say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.",
      );
  });

test("no-comments refuses directive-lookalike prose and trailing lines in template files, and admits exact directives", async () => {
  for (const code of refusedDirectiveLookalikes) {
    expect(await hits("no-comments", templateSourceFile, code)).toEqual([
      { line: 1, message: fullCommentMessage },
    ]);
  }
  for (const code of admittedDirectives) {
    expect(await hits("no-comments", templateSourceFile, code)).toEqual([]);
  }
});

const inlineDirectivePaths = [
  templateSourceFile,
  "scripts/read-file.ts",
  "tests/template/doctor/doctor.test.ts",
  "config/template-rules.mjs",
  "eslint.config.mjs",
  "kernel/src/addons/menu/index.ts",
  "tests/kernel/lint-rules.test.ts",
  "skills/verify-cli/helper/place.ts",
] as const;

const inlineDirectiveMembers = [
  [
    "/* eslint-disable */\nexport const a = 1;",
    "'/* eslint-disable */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "// eslint-disable-next-line repository/no-in-operator -- Hack: silence rule\nexport const a = 1;",
    "'// eslint-disable-next-line repository/no-in-operator -- Hack: silence rule' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* eslint-disable-next-line repository/no-in-operator -- Hack: silence rule */\nexport const a = 1;",
    "'/* eslint-disable-next-line repository/no-in-operator -- Hack: silence rule */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "export const a = 1; // eslint-disable-line no-console",
    "'// eslint-disable-line no-console' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "export const a = 1; /* eslint-disable-line no-console */",
    "'/* eslint-disable-line no-console */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* eslint-enable */\nexport const a = 1;",
    "'/* eslint-enable */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* eslint no-console: off */\nexport const a = 1;",
    "'/* eslint no-console: off */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* global x */\nexport const a = 1;",
    "'/* global x */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* globals x */\nexport const a = 1;",
    "'/* globals x */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* globals */\nexport const a = 1;",
    "'/* globals */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* exported a */\nexport const a = 1;",
    "'/* exported a */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
  [
    "/* exported */\nexport const a = 1;",
    "'/* exported */' has no effect because you have 'noInlineConfig' setting in your config.",
  ],
] as const;

test("noInlineConfig refuses every inline ESLint directive across all repository paths and keeps rules active", async () => {
  for (const filePath of inlineDirectivePaths) {
    for (const [code, expectedMessage] of inlineDirectiveMembers) {
      const found = (await messages(filePath, code)).filter(
        ({ ruleId }) => ruleId === null,
      );
      expect(found).toEqual([
        { ruleId: null, line: 1, message: expectedMessage },
      ]);
    }
  }
  const planted = await messages(
    "scripts/read-file.ts",
    [
      "export function errorCode(error: unknown): boolean {",
      '  if (typeof error !== "object" || error === null) return false;',
      "  // eslint-disable-next-line repository/no-in-operator -- Hack: silence rule",
      '  return "code" in error;',
      "}",
    ].join("\n"),
  );
  expect(planted.map(({ ruleId, line }) => [ruleId, line])).toEqual([
    [null, 3],
    ["repository/no-in-operator", 4],
  ]);
  expect(
    await messages(
      "scripts/read-file.ts",
      [
        "export function errorCode(error: unknown): boolean {",
        '  if (typeof error !== "object" || error === null) return false;',
        '  return Object.hasOwn(error, "code");',
        "}",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("loadBiomeCategories fails closed with a repair message on broken schemas and admits valid schemas", () => {
  const folder = testFolder("biome-schema-");
  const unreadablePath = join(folder, "unreadable.json");
  const schemaError = (detail: string) =>
    `Cannot load directive metadata from @biomejs/biome/configuration_schema.json (${detail}). Repair: reinstall dependencies with bun install --frozen-lockfile.`;
  try {
    const missingPath = join(folder, "missing.json");
    expect(() => loadBiomeCategories(missingPath)).toThrow(
      schemaError("cannot read file"),
    );

    writeFileSync(unreadablePath, "{}");
    chmodSync(unreadablePath, 0o000);
    expect(() => loadBiomeCategories(unreadablePath)).toThrow(
      schemaError("cannot read file"),
    );
    chmodSync(unreadablePath, 0o600);

    const invalidSchemas: readonly [string, string, string][] = [
      ["malformed.json", "{not json", "malformed JSON"],
      ["null.json", "null", "missing $defs"],
      ["array.json", "[]", "missing $defs"],
      ["no-defs.json", "{}", "missing $defs"],
      [
        "no-rules.json",
        JSON.stringify({
          $defs: {
            Actions: { properties: { source: { $ref: "#/$defs/Source" } } },
            Source: { properties: { organizeImports: {} } },
          },
        }),
        "missing Rules",
      ],
      [
        "no-actions.json",
        JSON.stringify({
          $defs: {
            Rules: { properties: { style: { $ref: "#/$defs/Style" } } },
            Style: { properties: { useConst: {} } },
          },
        }),
        "missing Actions",
      ],
      [
        "empty-rules.json",
        JSON.stringify({
          $defs: {
            Rules: { properties: { recommended: {} } },
            Actions: { properties: { source: { $ref: "#/$defs/Source" } } },
            Source: { properties: { organizeImports: {} } },
          },
        }),
        "empty Rules",
      ],
      [
        "empty-actions.json",
        JSON.stringify({
          $defs: {
            Rules: { properties: { style: { $ref: "#/$defs/Style" } } },
            Style: { properties: { useConst: {} } },
            Actions: { properties: { recommended: {} } },
          },
        }),
        "empty Actions",
      ],
      [
        "unresolved-group.json",
        JSON.stringify({
          $defs: {
            Rules: { properties: { style: { $ref: "#/$defs/Missing" } } },
            Actions: { properties: { source: { $ref: "#/$defs/Source" } } },
            Source: { properties: { organizeImports: {} } },
          },
        }),
        "unresolved Rules.style",
      ],
      [
        "empty-group.json",
        JSON.stringify({
          $defs: {
            Rules: { properties: { style: { $ref: "#/$defs/Style" } } },
            Style: { properties: { recommended: {} } },
            Actions: { properties: { source: { $ref: "#/$defs/Source" } } },
            Source: { properties: { organizeImports: {} } },
          },
        }),
        "empty Rules.style",
      ],
      [
        "cyclic-ref.json",
        JSON.stringify({
          $defs: {
            Rules: { properties: { style: { $ref: "#/$defs/CycleA" } } },
            CycleA: { anyOf: [{ $ref: "#/$defs/CycleB" }] },
            CycleB: { anyOf: [{ $ref: "#/$defs/CycleA" }] },
            Actions: { properties: { source: { $ref: "#/$defs/Source" } } },
            Source: { properties: { organizeImports: {} } },
          },
        }),
        "unresolved Rules.style",
      ],
    ];

    for (const [name, content, detail] of invalidSchemas) {
      const fixturePath = join(folder, name);
      writeFileSync(fixturePath, content);
      expect(() => loadBiomeCategories(fixturePath)).toThrow(
        schemaError(detail),
      );
    }

    const validPath = join(folder, "valid.json");
    writeFileSync(
      validPath,
      JSON.stringify({
        $defs: {
          Rules: {
            properties: {
              recommended: {},
              style: { $ref: "#/$defs/Style" },
            },
          },
          Style: { properties: { recommended: {}, useConst: {} } },
          Actions: {
            properties: {
              recommended: {},
              source: { $ref: "#/$defs/Source" },
            },
          },
          Source: { properties: { recommended: {}, organizeImports: {} } },
        },
      }),
    );
    const loaded = loadBiomeCategories(validPath);
    expect([...loaded].sort()).toEqual([
      "assist",
      "assist/source/organizeImports",
      "format",
      "lint",
      "lint/style",
      "lint/style/useConst",
      "parse",
    ]);

    const installed = loadBiomeCategories();
    expect(installed.has("lint/style/useConst")).toBe(true);
    expect(installed.has("assist/source/organizeImports")).toBe(true);
  } finally {
    chmodSync(unreadablePath, 0o600);
    rmSync(folder, { recursive: true, force: true });
  }
});
