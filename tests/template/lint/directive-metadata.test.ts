import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  loadBiomeCategories,
  loadFallowTargets,
} from "../../../config/comment-directives.mjs";
import { supportedFallowTargets } from "../../support/lint-comment-cases.ts";
import { testFolder } from "../../support/test-folder.ts";

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
      [
        "null-oneof-rule-def.json",
        schemaWith({ UseConstConfiguration: { oneOf: null } }),
        "invalid Rules.style.useConst",
      ],
      [
        "null-oneof-action-def.json",
        schemaWith({ OrganizeImportsConfiguration: { oneOf: null } }),
        "invalid Actions.source.organizeImports",
      ],
      [
        "empty-oneof-rule-def.json",
        schemaWith({ UseConstConfiguration: { oneOf: [] } }),
        "invalid Rules.style.useConst",
      ],
      [
        "null-oneof-item-rule-def.json",
        schemaWith({ UseConstConfiguration: { oneOf: [null] } }),
        "invalid Rules.style.useConst",
      ],
      [
        "null-anyof-rule-def.json",
        schemaWith({ UseConstConfiguration: { anyOf: null } }),
        "invalid Rules.style.useConst",
      ],
      [
        "empty-anyof-rule-def.json",
        schemaWith({ UseConstConfiguration: { anyOf: [] } }),
        "invalid Rules.style.useConst",
      ],
      [
        "invalid-type-rule-def.json",
        schemaWith({ UseConstConfiguration: { type: "bogus" } }),
        "invalid Rules.style.useConst",
      ],
      [
        "description-only-rule-def.json",
        schemaWith({ UseConstConfiguration: { description: "no schema" } }),
        "invalid Rules.style.useConst",
      ],
      [
        "broken-nested-ref-rule-def.json",
        schemaWith({
          UseConstConfiguration: {
            oneOf: [{ $ref: "#/$defs/MissingNested" }],
          },
        }),
        "invalid Rules.style.useConst",
      ],
      [
        "cyclic-rule-def.json",
        schemaWith({
          UseConstConfiguration: {
            oneOf: [{ $ref: "#/$defs/UseConstConfiguration" }],
          },
        }),
        "invalid Rules.style.useConst",
      ],
      [
        "malformed-nested-property-def.json",
        schemaWith({
          UseConstConfiguration: {
            oneOf: [{ $ref: "#/$defs/RuleWithUseConstOptions" }],
          },
          RuleWithUseConstOptions: {
            type: "object",
            properties: { level: { oneOf: null } },
          },
        }),
        "invalid Rules.style.useConst",
      ],
      [
        "malformed-items-rule-def.json",
        schemaWith({ UseConstConfiguration: { type: "array", items: null } }),
        "invalid Rules.style.useConst",
      ],
      [
        "malformed-additional-properties-rule-def.json",
        schemaWith({
          UseConstConfiguration: { type: "object", additionalProperties: {} },
        }),
        "invalid Rules.style.useConst",
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
    const writeInstalledMutation = (
      name: string,
      mutate: (key: string, value: unknown) => unknown,
    ) => {
      const targetPath = join(folder, name);
      writeFileSync(
        targetPath,
        JSON.stringify(JSON.parse(installedText, mutate)),
      );
      return targetPath;
    };
    expect(() =>
      loadBiomeCategories(
        writeInstalledMutation("installed-missing-use-const.json", (k, v) =>
          k === "UseConstConfiguration" ? undefined : v,
        ),
      ),
    ).toThrow(schemaError("invalid Rules.style.useConst"));
    expect(() =>
      loadBiomeCategories(
        writeInstalledMutation("installed-null-use-const.json", (k, v) =>
          k === "useConst" ? null : v,
        ),
      ),
    ).toThrow(schemaError("invalid Rules.style.useConst"));
    expect(() =>
      loadBiomeCategories(
        writeInstalledMutation("installed-null-oneof-use-const.json", (k, v) =>
          k === "UseConstConfiguration" ? { oneOf: null } : v,
        ),
      ),
    ).toThrow(schemaError("invalid Rules.style.useConst"));
    expect(() =>
      loadBiomeCategories(
        writeInstalledMutation(
          "installed-null-oneof-organize-imports.json",
          (k, v) =>
            k === "OrganizeImportsConfiguration" ? { oneOf: null } : v,
        ),
      ),
    ).toThrow(schemaError("invalid Actions.source.organizeImports"));

    const validPath = join(folder, "valid.json");
    writeFileSync(
      validPath,
      schemaWith({
        UseConstConfiguration: {
          oneOf: [
            { $ref: "#/$defs/RulePlainConfiguration" },
            { $ref: "#/$defs/RuleWithUseConstOptions" },
          ],
        },
        RulePlainConfiguration: {
          oneOf: [
            { type: "string", const: "off" },
            { type: "string", const: "error" },
          ],
        },
        RuleWithUseConstOptions: {
          type: "object",
          properties: {
            level: { $ref: "#/$defs/RulePlainConfiguration" },
            source: {
              anyOf: [{ $ref: "#/$defs/SourceGlob" }, { type: "null" }],
            },
            words: { type: ["array", "null"], items: { type: "string" } },
          },
          additionalProperties: false,
        },
        SourceGlob: { $ref: "#/$defs/Glob" },
        Glob: { type: "string" },
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

    const installedCopyPath = join(folder, "installed-copy.json");
    writeFileSync(installedCopyPath, installedText);
    const installed = loadBiomeCategories(installedCopyPath);
    expect(installed.has("lint/style/useConst")).toBe(true);
    expect(installed.has("assist/source/organizeImports")).toBe(true);
    expect(loadBiomeCategories().has("lint/style/useConst")).toBe(true);
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
