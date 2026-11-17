import js from "@eslint/js";
import tseslint from "typescript-eslint";
import repository from "../eslint-rules.mjs";

// Explicit rooted contract scopes. T7 owns rendering these for generated hosts.
const scopes = [
  "starters/contract3/src/**/*.{ts,mts,cts}",
  "tests/contract3/**/*.{ts,mts,cts}",
];
const boundary = "starters/contract3/src/kernel/validation/**/*.{ts,mts,cts}";
const stateFactoryProperty = {
  property: "stateAddon",
  message:
    "Only the stamped state add-on folder may author the state add-on factory.",
};
// CMD-14: no-restricted-imports sees static imports only, so the dynamic
// import of the process module is banned by syntax in every source scope (F09).
const childProcessImport = {
  selector:
    "ImportExpression:matches([source.value=/^(node:)?child_process$/], [source.quasis.0.value.cooked=/^(node:)?child_process$/])",
  message:
    "Contract 3 source starts programs only through the programs add-on.",
};
// DIAG-17, CMD-16: only the diagnostics add-on folder imports a logging
// library, and only the pinned LogTape packages.
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
// REC-7b, Q01: the state add-on's test seams (fixture.ts) and its internal
// implementation (install.ts and the rest) are never host-reachable; only its
// public index is.
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
// Linux route decision (16 November 2026): bun:ffi only in the state
// add-on's linux-flock.ts, the one module that owns the coordination lock's
// foreign call.
const ffiRoute = "starters/contract3/src/addons/state/linux-flock.ts";
const ffiMessage =
  "bun:ffi belongs only to the state add-on's linux-flock.ts (the Linux coordination lock call).";
const ffiPath = { name: "bun:ffi", message: ffiMessage };
const ffiImport = {
  selector:
    "ImportExpression:matches([source.value='bun:ffi'], [source.quasis.0.value.cooked='bun:ffi'])",
  message: ffiMessage,
};
// T3 delta review F1: the spellings that reach the kernel's or the state
// add-on's internals without matching the canonical path. Lint is a guard
// against accident, not isolation.
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
// Source outside the kernel: the public-index bans, the logging ban, the F1
// spellings and, except in the Linux route module, the bun:ffi ban. The
// diagnostics folder passes its own logging group (the pinned LogTape
// packages allowed) and keeps every other rule.
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
            // A doubled slash, a "." segment after a slash, a leading
            // "./" before "..", or a named segment followed by "..".
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
export default tseslint.config(
  {
    files: scopes,
    linterOptions: { noInlineConfig: true },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: new URL("..", import.meta.url).pathname,
      },
    },
    rules,
  },
  {
    files: ["starters/contract3/src/**/*.{ts,mts,cts}"],
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
    files: ["starters/contract3/src/**/*.{ts,mts,cts}"],
    ignores: ["starters/contract3/src/kernel/**", ffiRoute],
    rules: hostRules(),
  },
  {
    // The one module that may import bun:ffi; every other host rule holds.
    files: [ffiRoute],
    rules: hostRules({ banFfi: false }),
  },
  {
    files: ["starters/contract3/src/kernel/index.ts"],
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
  {
    files: ["tests/contract3/locks/**/*.{ts,mts,cts}"],
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
  {
    // DIAG-17: the one folder that may import the pinned logging packages.
    // Every other host rule (public indexes, F1 spellings, bun:ffi) holds.
    files: ["starters/contract3/src/addons/diagnostics/**/*.{ts,mts,cts}"],
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
  },
  {
    files: ["starters/contract3/src/addons/state/**/*.{ts,mts,cts}"],
    rules: { "no-restricted-properties": ["error", ...programProperties] },
  },
  {
    // CMD-14: only the programs add-on folder may start programs, and only
    // through the asynchronous Bun.spawn.
    files: ["starters/contract3/src/addons/programs/**/*.{ts,mts,cts}"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...programProperties.filter((entry) => entry.property !== "spawn"),
        stateFactoryProperty,
      ],
    },
  },
  {
    // GATE-12: the kernel writer's process adapter is the one output owner.
    files: ["starters/contract3/src/kernel/process-host.ts"],
    rules: { "repository/no-domain-output": "off" },
  },
);
