import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  loadBiomeCategories,
  loadFallowTargets,
} from "../../../config/comment-directives.mjs";
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

const withExport = (comment: string) => `${comment}\nexport const a = 1;`;

const refusedDirectiveLookalikes = [
  withExport(
    "// global state is fine here: resolution runs once.\n// TODO remove the cast once the adapter types land.",
  ),
  withExport("// global state is fine here."),
  withExport("// globals are shared here."),
  withExport("// exported from index."),
  withExport("// eslint is strict here."),
  withExport("// eslint-disable TODO smuggled prose"),
  withExport("// eslint-enable TODO smuggled prose"),
  withExport("// eslint-foo bar"),
  withExport("// eslint-disable-foo bar"),
  withExport("// @ts-foo bar"),
  withExport("// @ts-expect-errors bar"),
  withExport("// biome-ignore-foo bar"),
  withExport("// fallow-ignore-foo bar"),
  withExport("// @ts-expect-error: bad type\n// TODO remove this cast"),
  withExport("// eslint-disable-next-line no-console\n// TODO remove this"),
  withExport("// biome-ignore format: keep table aligned\n// TODO clean up"),
  withExport(
    "// fallow-ignore-next-line unused-export -- kept for api\n// TODO clean up",
  ),
  withExport("/* @ts-expect-error: bad type\n   TODO remove this */"),
  withExport(
    "/* biome-ignore format: keep table\u2028TODO remove this cast */",
  ),
  withExport(
    "/* biome-ignore format: keep table\u2029TODO remove this cast */",
  ),
  withExport("/* fallow-ignore-next-line is how you hide a finding. */"),
  withExport("// fallow-ignore-next-line is how you hide a finding."),
  withExport("// fallow-ignore unused-export"),
  withExport("// fallow-ignore-next-line unused -- kept for api"),
  withExport("/* @ts-nocheck prose */"),
  withExport("/* @ts-check prose */"),
  withExport("/* @ts-nocheck */"),
  withExport("/* @ts-check */"),
  withExport("// @ts-nocheck prose"),
  withExport("// @ts-check prose"),
  withExport("// biome-ignore format"),
  withExport("// biome-ignore prose without colon"),
  withExport("// biome-ignore-all foo: reason"),
  withExport("/* eslint-disable TODO smuggled prose */"),
  withExport("/* global state is fine here. */"),
  withExport("/* exported from index. */"),
  withExport("/* eslint is strict here. */"),
  withExport("// eslint-disable"),
  withExport("// eslint-enable"),
  withExport("// eslint no-console: off"),
  withExport("// global foo"),
  withExport("// globals foo"),
  withExport("// exported a"),
  withExport("/* globals */"),
  withExport("/* exported */"),
  "export const a = 1; /* fallow-ignore-file -- prose */",
  "/* fallow-ignore-file -- prose */ export const b = 1;",
  "export const a = 1; /* fallow-ignore-next-line unused-export -- prose */",
  "/* fallow-ignore-next-line unused-export -- prose */ export const b = 1;",
  withExport(
    "// biome-ignore lint/remove/thisCast: prose must not become permission",
  ),
  withExport("// biome-ignore lint/fakeGroup: prose"),
  withExport("// biome-ignore lint/style/fakeRule: prose"),
  withExport("// biome-ignore assist/source: prose"),
  withExport("// biome-ignore assist/source/fakeAction: prose"),
  withExport("// biome-ignore lint/style/useConst lint/style/fakeRule: prose"),
  withExport("// biome-ignore lint/style/useConst prose: reason"),
  withExport("// fallow-ignore-next-line this-is-plain-prose"),
  withExport("// fallow-ignore-file this-is-plain-prose"),
  withExport(
    "// fallow-ignore-next-line unused-exports -- plural is not accepted",
  ),
  withExport(
    "// fallow-ignore-next-line unused-optional-dependency -- not parsed by fallow",
  ),
  withExport(
    "// fallow-ignore-next-line unused-optional-deps -- not parsed by fallow",
  ),
  withExport(
    "// fallow-ignore-next-line boundary-coverage -- not parsed by fallow",
  ),
  withExport(
    "// fallow-ignore-next-line boundary-coverage-violations -- wrong alias",
  ),
  withExport(
    "// fallow-ignore-next-line sql-injection -- must use security-sink",
  ),
  withExport(
    "// fallow-ignore-next-line high-complexity -- must use complexity",
  ),
  withExport("// fallow-ignore-next-line unused-export, fake-target -- mixed"),
  withExport("// fallow-ignore-next-line policy-violation:bad -- missing rule"),
  withExport("// fallow-ignore-next-line unused-export --"),
] as const;

const admittedDirectives = [
  withExport("// @ts-expect-error -- lock test"),
  withExport("// @ts-expect-error: lock test"),
  withExport("// @ts-ignore reason"),
  withExport("// @ts-nocheck"),
  withExport("// @ts-check"),
  withExport("// biome-ignore format: keep table"),
  withExport("// biome-ignore lint/style/useConst: keep binding mutable"),
  withExport(
    "// biome-ignore lint/style/useConst lint/suspicious/noExplicitAny: reason",
  ),
  withExport(
    "// biome-ignore lint/style/useConst(foo) lint/suspicious/noExplicitAny: reason",
  ),
  withExport("// biome-ignore assist/source/organizeImports: preserve order"),
  withExport("// fallow-ignore-next-line -- blanket reason"),
  withExport("// fallow-ignore-next-line complexity -- kept complex"),
  withExport("// fallow-ignore-file complexity -- kept complex"),
  withExport(
    "// fallow-ignore-next-line unused-export, complexity -- combined",
  ),
  withExport(
    "// fallow-ignore-next-line policy-violation:pack/rule -- scoped rule",
  ),
  withExport("// fallow-ignore-next-line unused-export -- kept for api"),
  withExport("// fallow-ignore-file unused-export -- kept for api"),
  withExport("/* fallow-ignore-file unused-export -- kept for api */"),
  withExport("  /* fallow-ignore-next-line unused-export -- kept for api */"),
  ...supportedFallowTargets.map((target) =>
    withExport(`// fallow-ignore-next-line ${target} -- supported`),
  ),
  withExport("// eslint-disable-next-line no-console"),
  withExport(
    "// eslint-disable-next-line @typescript-eslint/consistent-type-assertions",
  ),
  "export const a = 1; // eslint-disable-line no-console",
  withExport("/* eslint-disable */"),
  withExport("/* eslint-enable */"),
  withExport("/* eslint no-console: off */"),
  withExport("/* global foo */"),
  withExport("/* globals foo */"),
  withExport("/* exported a */"),
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
  expect([...loadFallowTargets()].sort()).toEqual([...supportedFallowTargets]);
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

const noInlineMessage = (directive: string) =>
  `'${directive}' has no effect because you have 'noInlineConfig' setting in your config.`;

const inlineDirectiveMembers = [
  ...[
    "/* eslint-disable */",
    "// eslint-disable-next-line repository/no-in-operator -- Hack: silence rule",
    "/* eslint-disable-next-line repository/no-in-operator -- Hack: silence rule */",
    "/* eslint-enable */",
    "/* eslint no-console: off */",
    "/* global x */",
    "/* globals x */",
    "/* globals */",
    "/* exported a */",
    "/* exported */",
  ].map((d) => [withExport(d), noInlineMessage(d)] as const),
  [
    "export const a = 1; // eslint-disable-line no-console",
    noInlineMessage("// eslint-disable-line no-console"),
  ],
  [
    "export const a = 1; /* eslint-disable-line no-console */",
    noInlineMessage("/* eslint-disable-line no-console */"),
  ],
] as const;

const inlineDirectiveLintBound = 60_000;

test(
  "noInlineConfig refuses every inline ESLint directive across all repository paths and keeps rules active",
  async () => {
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
  },
  inlineDirectiveLintBound,
);

test("loadBiomeCategories fails closed with a repair message on broken schemas and admits valid schemas", () => {
  const folder = testFolder("biome-schema-");
  const unreadablePath = join(folder, "unreadable.json");
  const schemaError = (detail: string) =>
    `Cannot load directive metadata from @biomejs/biome/configuration_schema.json (${detail}). Repair: reinstall dependencies with bun install --frozen-lockfile.`;
  const validUseConst = {
    anyOf: [{ $ref: "#/$defs/UseConstConfiguration" }, { type: "null" }],
  };
  const validOrganizeImports = {
    anyOf: [{ $ref: "#/$defs/OrganizeImportsConfiguration" }, { type: "null" }],
  };
  const baseDefs = (): Record<string, unknown> => ({
    UseConstConfiguration: { oneOf: [{ type: "string" }] },
    OrganizeImportsConfiguration: { oneOf: [{ type: "string" }] },
    Rules: {
      properties: { recommended: {}, style: { $ref: "#/$defs/Style" } },
    },
    Style: { properties: { recommended: {}, useConst: validUseConst } },
    Actions: {
      properties: { recommended: {}, source: { $ref: "#/$defs/Source" } },
    },
    Source: {
      properties: { recommended: {}, organizeImports: validOrganizeImports },
    },
  });
  const schemaWith = (
    overrides: Record<string, unknown>,
    remove: readonly string[] = [],
  ) => {
    const defs = { ...baseDefs(), ...overrides };
    for (const key of remove) delete defs[key];
    return JSON.stringify({ $defs: defs });
  };
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
      ["no-rules.json", schemaWith({}, ["Rules"]), "missing Rules"],
      ["no-actions.json", schemaWith({}, ["Actions"]), "missing Actions"],
      [
        "empty-rules.json",
        schemaWith({ Rules: { properties: { recommended: {} } } }),
        "empty Rules",
      ],
      [
        "empty-actions.json",
        schemaWith({ Actions: { properties: { recommended: {} } } }),
        "empty Actions",
      ],
      [
        "unresolved-group.json",
        schemaWith({
          Rules: { properties: { style: { $ref: "#/$defs/Missing" } } },
        }),
        "unresolved Rules.style",
      ],
      [
        "empty-group.json",
        schemaWith({ Style: { properties: { recommended: {} } } }),
        "empty Rules.style",
      ],
      [
        "cyclic-ref.json",
        schemaWith({
          Rules: { properties: { style: { $ref: "#/$defs/CycleA" } } },
          CycleA: { anyOf: [{ $ref: "#/$defs/CycleB" }] },
          CycleB: { anyOf: [{ $ref: "#/$defs/CycleA" }] },
        }),
        "unresolved Rules.style",
      ],
      [
        "null-rule-entry.json",
        schemaWith({ Style: { properties: { useConst: null } } }),
        "invalid Rules.style.useConst",
      ],
      [
        "empty-rule-entry.json",
        schemaWith({ Style: { properties: { useConst: {} } } }),
        "invalid Rules.style.useConst",
      ],
      [
        "missing-rule-def.json",
        schemaWith({}, ["UseConstConfiguration"]),
        "invalid Rules.style.useConst",
      ],
      [
        "empty-rule-def.json",
        schemaWith({ UseConstConfiguration: {} }),
        "invalid Rules.style.useConst",
      ],
      [
        "malformed-anyof-entry.json",
        schemaWith({
          Style: {
            properties: {
              useConst: {
                anyOf: [{ $ref: "#/$defs/UseConstConfiguration" }, null],
              },
            },
          },
        }),
        "invalid Rules.style.useConst",
      ],
      [
        "null-action-entry.json",
        schemaWith({ Source: { properties: { organizeImports: null } } }),
        "invalid Actions.source.organizeImports",
      ],
      [
        "missing-action-def.json",
        schemaWith({}, ["OrganizeImportsConfiguration"]),
        "invalid Actions.source.organizeImports",
      ],
    ];

    for (const [name, content, detail] of invalidSchemas) {
      const fixturePath = join(folder, name);
      writeFileSync(fixturePath, content);
      expect(() => loadBiomeCategories(fixturePath)).toThrow(
        schemaError(detail),
      );
    }

    const require = createRequire(import.meta.url);
    const installedText = readFileSync(
      require.resolve("@biomejs/biome/configuration_schema.json"),
      "utf8",
    );
    const withoutUseConstPath = join(
      folder,
      "installed-missing-use-const.json",
    );
    writeFileSync(
      withoutUseConstPath,
      JSON.stringify(
        JSON.parse(installedText, (key, value: unknown) =>
          key === "UseConstConfiguration" ? undefined : value,
        ),
      ),
    );
    expect(() => loadBiomeCategories(withoutUseConstPath)).toThrow(
      schemaError("invalid Rules.style.useConst"),
    );

    const nullUseConstPath = join(folder, "installed-null-use-const.json");
    writeFileSync(
      nullUseConstPath,
      JSON.stringify(
        JSON.parse(installedText, (key, value: unknown) =>
          key === "useConst" ? null : value,
        ),
      ),
    );
    expect(() => loadBiomeCategories(nullUseConstPath)).toThrow(
      schemaError("invalid Rules.style.useConst"),
    );

    const validPath = join(folder, "valid.json");
    writeFileSync(validPath, schemaWith({}));
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

test("loadFallowTargets fails closed with a repair message on broken registries and admits valid registries", () => {
  const folder = testFolder("fallow-registry-");
  const unreadablePath = join(folder, "unreadable.json");
  const registryError = (detail: string) =>
    `Cannot load directive metadata from fallow/issue-registry.json (${detail}). Repair: reinstall dependencies with bun install --frozen-lockfile.`;
  try {
    const missingPath = join(folder, "missing.json");
    expect(() => loadFallowTargets(missingPath)).toThrow(
      registryError("cannot read file"),
    );

    writeFileSync(unreadablePath, "{}");
    chmodSync(unreadablePath, 0o000);
    expect(() => loadFallowTargets(unreadablePath)).toThrow(
      registryError("cannot read file"),
    );
    chmodSync(unreadablePath, 0o600);

    const invalidRegistries: readonly [string, string, string][] = [
      ["malformed.json", "{not json", "malformed JSON"],
      ["null.json", "null", "missing issue_types"],
      ["array.json", "[]", "missing issue_types"],
      ["missing-list.json", "{}", "missing issue_types"],
      ["empty-list.json", JSON.stringify({ issue_types: [] }), "empty targets"],
    ];

    for (const [name, content, detail] of invalidRegistries) {
      const fixturePath = join(folder, name);
      writeFileSync(fixturePath, content);
      expect(() => loadFallowTargets(fixturePath)).toThrow(
        registryError(detail),
      );
    }

    const validPath = join(folder, "valid.json");
    writeFileSync(
      validPath,
      JSON.stringify({
        issue_types: [
          {
            id: "unused-export",
            registry_index: 1,
            suppress_comment: "// fallow-ignore-next-line unused-export",
            aliases: [],
          },
          {
            id: "unused-dev-dependency",
            registry_index: 7,
            suppress_comment: null,
            aliases: ["unused-dev-deps", "unused-dev-dependencies"],
          },
          {
            id: "unused-optional-dependency",
            registry_index: 8,
            suppress_comment: null,
            aliases: ["unused-optional-deps", "unused-optional-dependencies"],
          },
          {
            id: "boundary-coverage",
            registry_index: 25,
            suppress_comment: "// fallow-ignore-file boundary-violation",
            aliases: ["boundary-coverage-violations"],
          },
          {
            id: "high-complexity",
            registry_index: null,
            suppress_comment: "// fallow-ignore-next-line complexity",
            aliases: [],
          },
        ],
      }),
    );
    expect([...loadFallowTargets(validPath)].sort()).toEqual([
      "boundary-violation",
      "complexity",
      "unused-dev-dependencies",
      "unused-dev-dependency",
      "unused-dev-deps",
      "unused-export",
    ]);
    expect([...loadFallowTargets()].sort()).toEqual([
      ...supportedFallowTargets,
    ]);
  } finally {
    chmodSync(unreadablePath, 0o600);
    rmSync(folder, { recursive: true, force: true });
  }
});
