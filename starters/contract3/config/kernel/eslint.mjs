import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import kernelRules from "./eslint-rules.mjs";

const stateFactoryProperty = {
  property: "stateAddon",
  message:
    "Only the stamped state add-on folder may author the state add-on factory.",
};
// Platform: CMD-14: no-restricted-imports sees static imports only, so the dynamic
// import of the process module is banned by syntax in every source scope (F09).
const childProcessImport = {
  selector:
    "ImportExpression:matches([source.value=/^(node:)?child_process$/], [source.quasis.0.value.cooked=/^(node:)?child_process$/])",
  message:
    "Contract 3 source starts programs only through the programs add-on.",
};
const loggingImports = {
  group: [
    "@logtape/*",
    "pino",
    "pino-*",
    "winston",
    "winston-*",
    "bunyan",
    "log4js",
    "loglevel",
    "consola",
    "signale",
  ],
  message: "Only the diagnostics add-on imports a logging library.",
};
const stateIndexOnly = {
  regex: "(?:^|/)addons/state/(?!index\\.(?:ts|mts|cts)$)",
  message:
    "Code outside the state add-on imports it through its public index only; its fixture and internals are test-only or internal.",
};
const kernelIndexOnly = {
  regex: "(?:^|/)kernel/(?!index\\.(?:ts|mts|cts)$)",
  message:
    "Code outside the kernel imports the stamped kernel through its public index only.",
};
const ffiMessage =
  "bun:ffi belongs only to the state add-on's linux-flock.ts (the Linux coordination lock call).";
const ffiPath = { name: "bun:ffi", message: ffiMessage };
const ffiImport = {
  selector:
    "ImportExpression:matches([source.value='bun:ffi'], [source.quasis.0.value.cooked='bun:ffi'])",
  message: ffiMessage,
};
const literalMessage =
  "Code outside the kernel and the state add-on imports them through their public index only, by a literal specifier: no computed or template-literal import(), require, createRequire or import.meta.require.";
const canonicalMessage =
  "Code outside the kernel and the state add-on imports them through their public index only, spelled canonically: no doubled slash, no leading ./ before .., and no . or .. segment inside a path.";
const reachability = [
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: literalMessage,
  },
  {
    selector:
      ":matches(CallExpression[callee.name='require'], CallExpression[callee.name='createRequire'], MemberExpression[object.type='MetaProperty'][property.name='require'])",
    message: literalMessage,
  },
  {
    selector:
      "ImportExpression[source.value=/\\x2f\\x2f|\\x2f[.]\\x2f|^[.]\\x2f[.][.]\\x2f/]",
    message: canonicalMessage,
  },
  {
    selector:
      "ImportExpression[source.value=/^[.][.]\\x2fstate\\x2f(?!index[.](ts|mts|cts)$)/]",
    message:
      "Code outside the state add-on imports it through its public index only.",
  },
];
const programProperties = [
  { object: "Bun", property: "spawn" },
  { object: "Bun", property: "spawnSync" },
  { object: "Bun", property: "$" },
];
const rules = {
  "no-restricted-properties": ["error", stateFactoryProperty],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/consistent-type-assertions": [
    "error",
    { assertionStyle: "never" },
  ],
  "@typescript-eslint/no-unnecessary-type-parameters": "error",
  "@typescript-eslint/switch-exhaustiveness-check": [
    "error",
    { considerDefaultExhaustiveForUnions: false },
  ],
  "@typescript-eslint/ban-ts-comment": [
    "error",
    {
      "ts-expect-error": true,
      "ts-ignore": true,
      "ts-nocheck": true,
      "ts-check": false,
    },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "CallExpression[callee.object.name='Object']:matches([callee.property.name='assign'], [callee.computed=true][callee.property.value='assign'])",
      message:
        "Contract values cannot use Object.assign; aliases remain a runtime/review obligation.",
    },
    {
      selector: "TSTypePredicate",
      message: "Type predicates belong only to the rooted validation folder.",
    },
  ],
  "no-console": "error",
};
function hostRules({ banFfi = true, logging = loggingImports } = {}) {
  return {
    "no-restricted-syntax": [
      ...rules["no-restricted-syntax"],
      childProcessImport,
      ...(banFfi ? [ffiImport] : []),
      ...reachability,
      {
        selector:
          "ImportExpression[source.value=/(^|\\x2f)kernel\\x2f(?!index[.](ts|mts|cts)$)/]",
        message:
          "Code outside the kernel imports the stamped kernel through its public index only.",
      },
      {
        selector:
          "ImportExpression[source.value=/(^|\\x2f)addons\\x2fstate\\x2f(?!index[.](ts|mts|cts)$)/]",
        message:
          "Code outside the state add-on imports it through its public index only.",
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          ...(banFfi ? [ffiPath] : []),
          {
            name: "node:module",
            importNames: ["createRequire"],
            message: literalMessage,
          },
          {
            name: "module",
            importNames: ["createRequire"],
            message: literalMessage,
          },
        ],
        patterns: [
          { group: ["**/tests/**", "node:child_process", "child_process"] },
          kernelIndexOnly,
          logging,
          stateIndexOnly,
          {
            regex:
              "//|/\\.(?:/|$)|^\\./\\.\\.(?:/|$)|(?:^|/)(?!\\.\\.?/)[^/]+/\\.\\.(?:/|$)",
            message: canonicalMessage,
          },
          {
            regex: "^\\.\\./state/(?!index\\.(?:ts|mts|cts)$)",
            message:
              "Code outside the state add-on imports it through its public index only; its fixture and internals are test-only or internal.",
          },
        ],
      },
    ],
  };
}
const declaration = JSON.parse(
  readFileSync(new URL("./host.json", import.meta.url), "utf8"),
);
const declaredAddons = Object.keys(declaration.addons);
const ts = "**/*.{ts,mts,cts}";

const text = (value) => typeof value === "string" && value !== "";
const settingRules = {
  rootDir: [
    (value) => text(value) && isAbsolute(value),
    "the absolute folder that holds tsconfig.json",
  ],
  srcDir: [
    (value) => text(value) && !isAbsolute(value) && !value.endsWith("/"),
    'the source folder relative to the folder ESLint runs in, such as "src"',
  ],
  testDirs: [
    (value) => Array.isArray(value) && value.every(text),
    "the test folders, or [] when there are none",
  ],
  addons: [
    (value) => value === "all" || Array.isArray(value),
    '"all" or the selected add-on names',
  ],
};

function settingsOf(options = {}) {
  for (const [name, [holds, what]] of Object.entries(settingRules))
    if (!holds(options[name]))
      throw new Error(`kernelLint needs ${name}: ${what}.`);
  const addons = options.addons === "all" ? declaredAddons : options.addons;
  const unknown = addons.find((name) => !declaredAddons.includes(name));
  if (unknown !== undefined)
    throw new Error(
      `kernelLint: add-on "${unknown}" is not declared in host.json. Declared: ${declaredAddons.join(", ")}.`,
    );
  const plugin = options.plugin ?? kernelRules;
  const replaced = Object.keys(kernelRules.rules).find(
    (id) => plugin.rules?.[id] !== kernelRules.rules[id],
  );
  if (replaced !== undefined)
    throw new Error(
      `kernelLint: the plugin must hold the kernel's own ${replaced} rule. Spread the kernel's rules after your own.`,
    );
  return { ...options, addons, repository: plugin };
}

export function kernelLint(options) {
  const { rootDir, srcDir, testDirs, addons, repository } = settingsOf(options);
  const selected = (name) => addons.includes(name);
  const source = `${srcDir}/${ts}`;
  const boundary = `${srcDir}/kernel/validation/${ts}`;
  const ffiRoute = `${srcDir}/addons/state/linux-flock.ts`;
  const addon = (name) => `${srcDir}/addons/${name}/${ts}`;
  const when = (name, block) => (selected(name) ? [block] : []);
  return tseslint.config(
    {
      files: [source, ...testDirs.map((dir) => `${dir}/${ts}`)],
      linterOptions: { noInlineConfig: true },
      extends: [
        js.configs.recommended,
        ...tseslint.configs.recommendedTypeChecked,
      ],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: rootDir,
        },
      },
      settings: { kernel: { srcDir } },
      rules,
    },
    {
      files: [source],
      plugins: { repository },
      rules: {
        "repository/no-domain-output": "error",
        "repository/no-locale-compare": "error",
        "no-restricted-syntax": [
          ...rules["no-restricted-syntax"],
          childProcessImport,
          ffiImport,
        ],
        "no-restricted-imports": [
          "error",
          {
            paths: [ffiPath],
            patterns: [
              { group: ["**/tests/**", "node:child_process", "child_process"] },
              loggingImports,
            ],
          },
        ],
        "no-restricted-properties": [
          "error",
          ...programProperties,
          stateFactoryProperty,
        ],
      },
    },
    {
      files: [source],
      ignores: [
        `${srcDir}/kernel/**`,
        ...(selected("state") ? [ffiRoute] : []),
      ],
      rules: hostRules(),
    },
    ...when("state", {
      files: [ffiRoute],
      rules: hostRules({ banFfi: false }),
    }),
    {
      files: [`${srcDir}/kernel/index.ts`],
      rules: {
        "no-restricted-properties": ["error", ...programProperties],
        "no-restricted-syntax": [
          ...rules["no-restricted-syntax"],
          childProcessImport,
          ffiImport,
          {
            selector:
              ":matches(MemberExpression[property.name='stateAddon'], MemberExpression[computed=true][property.value='stateAddon']):not(AssignmentExpression[operator='='][left.object.name='contractFor'][left.property.name='stateAddon'][right.name='createStateAddon'] > MemberExpression.left)",
            message:
              "Only the state add-on factory declaration may name stateAddon here.",
          },
          {
            selector:
              "ObjectPattern > :matches(Property[key.name='stateAddon'], Property[key.value='stateAddon'])",
            message:
              "Only the stamped state add-on may extract the state add-on factory.",
          },
        ],
      },
    },
    {
      files: [boundary],
      rules: {
        "@typescript-eslint/consistent-type-assertions": "off",
        "no-restricted-syntax": [
          "error",
          {
            selector:
              ":matches(TSAsExpression, TSTypeAssertion):not([typeAnnotation.type='TSTypeReference']):not([typeAnnotation.typeName.name='const'])",
            message: "Only a named boundary brand assertion is allowed.",
          },
          {
            selector:
              ":matches(TSAsExpression, TSTypeAssertion)[typeAnnotation.type='TSTypeReference']:not([typeAnnotation.typeName.name=/^(AuthorityId|ResourceId|ParsedPath)$/]):not([typeAnnotation.typeName.name='const'])",
            message: "Whole-result and arbitrary assertions are forbidden.",
          },
          {
            selector:
              "CallExpression[callee.object.name='Object']:matches([callee.property.name='assign'], [callee.computed=true][callee.property.value='assign'])",
            message: "Object.assign is forbidden.",
          },
          childProcessImport,
          ffiImport,
        ],
      },
    },
    ...(testDirs.length === 0
      ? []
      : [
          {
            files: testDirs.map((dir) => `${dir}/locks/${ts}`),
            rules: {
              "@typescript-eslint/ban-ts-comment": [
                "error",
                {
                  "ts-expect-error": "allow-with-description",
                  "ts-ignore": true,
                  "ts-nocheck": true,
                  "ts-check": false,
                },
              ],
            },
          },
        ]),
    ...when("diagnostics", {
      files: [addon("diagnostics")],
      rules: hostRules({
        logging: {
          group: [
            ...loggingImports.group.filter((name) => name !== "@logtape/*"),
            "@logtape/*",
            "!@logtape/logtape",
            "!@logtape/redaction",
          ],
          message: loggingImports.message,
        },
      }),
    }),
    ...when("state", {
      files: [addon("state")],
      rules: { "no-restricted-properties": ["error", ...programProperties] },
    }),
    ...when("programs", {
      files: [addon("programs")],
      rules: {
        "no-restricted-properties": [
          "error",
          ...programProperties.filter((entry) => entry.property !== "spawn"),
          stateFactoryProperty,
        ],
      },
    }),
    {
      files: [`${srcDir}/kernel/process-host.ts`],
      rules: { "repository/no-domain-output": "off" },
    },
    {
      files: [source],
      ignores: [
        `${srcDir}/kernel/**`,
        ...addons.map((name) => `${srcDir}/addons/${name}/**`),
      ],
      plugins: { repository },
      rules: {
        "repository/no-in-operator": "error",
        "repository/cause-literal-owner": "error",
      },
    },
  );
}
