import js from "@eslint/js";
import kernel, { kernelPaths } from "./config/contract3-repository-eslint.mjs";
import localRules from "./config/template-rules.mjs";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".fallow/**",
      ".worktrees/**",
      "profiles/**",
      "examples/**",
      "starters/simple/**",
      "starters/complex/**",
      "starters/shared/**",
      "proofs/**",
      "tools/oxlint/anti-slop/**",
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
    ignores: kernelPaths,
    plugins: { repository: localRules },
    rules: { "repository/no-comments": "error" },
  },
  {
    files: ["src/cli.ts"],
    rules: { "no-console": ["error", { allow: ["log"] }] },
  },

  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    plugins: { repository: localRules },
    rules: { "repository/no-locale-compare": "error" },
  },
  {
    files: ["tests/**/*.{ts,mts,cts}"],
    ignores: kernelPaths,
    plugins: { repository: localRules },
    rules: {
      "repository/require-to-throw-message": "error",
      "repository/tests-use-test-folder": "error",
      "repository/tests-no-sleep": "error",
    },
  },
  ...kernel,
);
