import contract3 from "./tests/contract3/lint-config.mjs";
import js from "@eslint/js";
import localRules from "./eslint-rules.mjs";
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...contract3,
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
    files: ["src/cli.ts"],
    rules: { "no-console": ["error", { allow: ["log"] }] },
  },

  {
    files: ["src/domains/**/*.ts"],
    plugins: { repository: localRules },
    rules: { "repository/no-domain-output": "error" },
  },
);
