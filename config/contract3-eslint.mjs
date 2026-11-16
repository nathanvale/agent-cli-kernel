import js from "@eslint/js";
import tseslint from "typescript-eslint";
import repository from "../eslint-rules.mjs";

// Explicit rooted contract scopes. T7 owns rendering these for generated hosts.
const scopes = [
  "starters/contract3/src/**/*.{ts,mts,cts}",
  "tests/contract3/**/*.{ts,mts,cts}",
];
const boundary = "starters/contract3/src/kernel/validation/**/*.{ts,mts,cts}";
const installerProperty = {
  property: "stateAddon",
  message:
    "State installer authoring belongs only to the canonical stamped state add-on folder.",
};
// CMD-14: no-restricted-imports sees static imports only, so the dynamic
// import of the process module is banned by syntax in every source scope (F09).
const childProcessImport = {
  selector:
    "ImportExpression:matches([source.value=/^(node:)?child_process$/], [source.quasis.0.value.cooked=/^(node:)?child_process$/])",
  message:
    "Contract 3 source starts programs only through the programs add-on.",
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
  "Host code imports the stamped kernel and the state add-on through their public index only, by a literal specifier: no computed or template import(), require, createRequire or import.meta.require.";
const canonicalMessage =
  "Host code imports the stamped kernel and the state add-on through their public index only, spelled canonically: no doubled slash and no . or .. segment inside a path.";
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
    selector: "ImportExpression[source.value=/\\x2f\\x2f|\\x2f[.]\\x2f/]",
    message: canonicalMessage,
  },
  {
    selector:
      "ImportExpression[source.value=/^[.][.]\\x2fstate\\x2f(?!index[.](ts|mts|cts)$)/]",
    message:
      "Host code imports the state add-on through its public index only.",
  },
];
const programProperties = [
  { object: "Bun", property: "spawn" },
  { object: "Bun", property: "spawnSync" },
  { object: "Bun", property: "$" },
];
const rules = {
  "no-restricted-properties": ["error", installerProperty],
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
// Source outside the kernel: the public-index bans, the F1 spellings and,
// except in the Linux route module, the bun:ffi ban.
function hostRules(banFfi) {
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
          "Host code imports the stamped kernel through its public index only.",
      },
      {
        selector:
          "ImportExpression[source.value=/(^|\\x2f)addons\\x2fstate\\x2f(?!index[.](ts|mts|cts)$)/]",
        message:
          "Host code imports the state add-on through its public index only.",
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
          {
            regex: "(?:^|/)kernel/(?!index\\.(?:ts|mts|cts)$)",
            message:
              "Host code imports the stamped kernel through its public index only.",
          },
          {
            // REC-7b, Q01: the state add-on's test seams (fixture.ts) and
            // its internal implementation (install.ts and the rest) are
            // never host-reachable; only its public index is.
            regex: "(?:^|/)addons/state/(?!index\\.(?:ts|mts|cts)$)",
            message:
              "Host code imports the state add-on through its public index only; its fixture and internals are test-only or internal.",
          },
          {
            regex: "//|/\\.(?:/|$)|(?:^|/)(?!\\.\\.?/)[^/]+/\\.\\.(?:/|$)",
            message: canonicalMessage,
          },
          {
            regex: "^\\.\\./state/(?!index\\.(?:ts|mts|cts)$)",
            message:
              "Host code imports the state add-on through its public index only; its fixture and internals are test-only or internal.",
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
      "no-restricted-syntax": [
        ...rules["no-restricted-syntax"],
        childProcessImport,
        ffiImport,
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [ffiPath],
          patterns: ["**/tests/**", "node:child_process", "child_process"],
        },
      ],
      "no-restricted-properties": [
        "error",
        ...programProperties,
        installerProperty,
      ],
    },
  },
  {
    files: ["starters/contract3/src/**/*.{ts,mts,cts}"],
    ignores: ["starters/contract3/src/kernel/**", ffiRoute],
    rules: hostRules(true),
  },
  {
    // The one module that may import bun:ffi; every other host rule holds.
    files: [ffiRoute],
    rules: hostRules(false),
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
            "Only the canonical state factory declaration may name stateAddon here.",
        },
        {
          selector:
            "ObjectPattern > :matches(Property[key.name='stateAddon'], Property[key.value='stateAddon'])",
          message:
            "State factory extraction belongs only to the stamped state owner.",
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
        installerProperty,
      ],
    },
  },
  {
    // GATE-12: the kernel writer's process adapter is the one output owner.
    files: ["starters/contract3/src/kernel/process-host.ts"],
    rules: { "repository/no-domain-output": "off" },
  },
);
