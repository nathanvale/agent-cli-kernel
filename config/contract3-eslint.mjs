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
      ],
      "no-restricted-imports": [
        "error",
        { patterns: ["**/tests/**", "node:child_process", "child_process"] },
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
    ignores: ["starters/contract3/src/kernel/**"],
    rules: {
      "no-restricted-syntax": [
        ...rules["no-restricted-syntax"],
        childProcessImport,
        {
          selector:
            "ImportExpression[source.value=/(^|\\x2f)kernel\\x2f(?!index[.](ts|mts|cts)$)/]",
          message:
            "Host code imports the stamped kernel through its public index only.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/tests/**", "node:child_process", "child_process"] },
            {
              regex: "(?:^|/)kernel/(?!index\\.(?:ts|mts|cts)$)",
              message:
                "Host code imports the stamped kernel through its public index only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["starters/contract3/src/kernel/index.ts"],
    rules: {
      "no-restricted-properties": ["error", ...programProperties],
      "no-restricted-syntax": [
        ...rules["no-restricted-syntax"],
        childProcessImport,
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
