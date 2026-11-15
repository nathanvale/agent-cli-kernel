import js from "@eslint/js";
import tseslint from "typescript-eslint";
import repository from "../../eslint-rules.mjs";

// Explicit rooted contract scopes. T7 owns rendering these for generated hosts.
const scopes = [
  "starters/contract3/src/**/*.{ts,mts,cts}",
  "tests/contract3/**/*.{ts,mts,cts}",
];
const boundary = "starters/contract3/src/kernel/validation/**/*.{ts,mts,cts}";
const rules = {
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
        "CallExpression[callee.object.name='Object'][callee.property.name='assign']",
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
        tsconfigRootDir: new URL("../..", import.meta.url).pathname,
      },
    },
    rules,
  },
  {
    files: ["starters/contract3/src/**/*.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/no-domain-output": "error",
      "no-restricted-imports": [
        "error",
        { patterns: ["**/tests/**", "node:child_process", "child_process"] },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Bun", property: "spawn" },
        { object: "Bun", property: "spawnSync" },
        { object: "Bun", property: "$" },
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
            "TSAsExpression:not([typeAnnotation.type='TSTypeReference']):not([typeAnnotation.typeName.name='const'])",
          message: "Only a named boundary brand assertion is allowed.",
        },
        {
          selector:
            "TSAsExpression[typeAnnotation.type='TSTypeReference']:not([typeAnnotation.typeName.name=/^(AuthorityId|ResourceId|ParsedPath)$/]):not([typeAnnotation.typeName.name='const'])",
          message: "Whole-result and arbitrary assertions are forbidden.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Object'][callee.property.name='assign']",
          message: "Object.assign is forbidden.",
        },
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
);
