import kernel from "./kernel-lint.mjs";
import repository from "../eslint-rules.mjs";

export const kernelPaths = ["kernel/**", "tests/kernel/**"];

export default [
  {
    files: [
      "kernel/**/*.{ts,mts,cts,mjs}",
      "tests/kernel/**/*.{ts,mts,cts,mjs}",
    ],
    plugins: { repository },
    rules: { "repository/no-comments": "error" },
  },
  ...kernel,
  {
    files: ["kernel/src/**/*.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/no-in-operator": "error",
      "repository/cause-literal-owner": "error",
    },
  },
  {
    files: ["tests/kernel/**/*.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/require-to-throw-message": "error",
      "repository/tests-use-test-folder": "error",
      "repository/tests-no-sleep": "error",
    },
  },
];
