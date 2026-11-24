import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import antiSlop, { chainedTypeAssertions } from "./config/anti-slop-rules.mjs";
import kernel, { kernelPaths } from "./config/kernel-repository-lint.mjs";
import payloadRules from "./config/payload-rules.mjs";
import platformRules from "./config/platform-rules.mjs";
import templateRules from "./config/template-rules.mjs";
import verifySkill, { verifySkillPaths } from "./config/verify-skill-lint.mjs";
import tseslint from "typescript-eslint";

const localRules = {
  rules: {
    ...templateRules.rules,
    ...platformRules.rules,
    ...payloadRules.rules,
  },
};

function withChainedTypeAssertions(config) {
  const restricted = config.rules?.["no-restricted-syntax"];
  if (!Array.isArray(restricted)) return config;
  return {
    ...config,
    rules: {
      ...config.rules,
      "no-restricted-syntax": [...restricted, ...chainedTypeAssertions],
    },
  };
}

export default defineConfig(
  { linterOptions: { noInlineConfig: true } },
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".fallow/**",
      ".worktrees/**",
      "config/*.d.mts",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-console": "error",
    },
  },
  {
    files: ["**/*.{ts,mts,cts,mjs}"],
    ignores: [...kernelPaths, ...verifySkillPaths],
    plugins: { repository: localRules },
    rules: {
      "repository/no-comments": "error",
      "repository/no-host-path-literal": "error",
    },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    plugins: { repository: localRules },
    rules: {
      "repository/no-locale-compare": "error",
      "repository/no-in-operator": "error",
    },
  },
  {
    files: ["tests/**/*.{ts,mts,cts}"],
    ignores: kernelPaths,
    plugins: { repository: localRules },
    rules: {
      "repository/require-to-throw-message": "error",
      "repository/tests-use-test-folder": "error",
      "repository/tests-no-sleep": "error",
      "repository/tests-use-bounded-runner": "error",
      "repository/tests-stub-tools": "error",
    },
  },
  {
    files: ["**/*.{mts,cts,tsx,jsx}"],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    ignores: [
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
    ],
    plugins: { "anti-slop": antiSlop },
    rules: {
      "no-restricted-syntax": ["error", ...chainedTypeAssertions],
      "anti-slop/no-accumulating-spread": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
    },
  },
  ...kernel.map(withChainedTypeAssertions),
  ...verifySkill,
  {
    files: ["**/*.{ts,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "all", argsIgnorePattern: "^_" },
      ],
    },
  },
);
