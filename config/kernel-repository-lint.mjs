import contract3 from "./contract3-eslint.mjs";
import repository from "../eslint-rules.mjs";

export const kernelPaths = ["starters/contract3/**", "tests/contract3/**"];

export default [
  {
    files: [
      "starters/contract3/**/*.{ts,mts,cts,mjs}",
      "tests/contract3/**/*.{ts,mts,cts,mjs}",
    ],
    plugins: { repository },
    rules: { "repository/no-comments": "error" },
  },
  ...contract3,
  {
    files: ["starters/contract3/src/**/*.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/no-in-operator": "error",
      "repository/cause-literal-owner": "error",
    },
  },
  {
    files: ["tests/contract3/**/*.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/require-to-throw-message": "error",
      "repository/tests-use-test-folder": "error",
      "repository/tests-no-sleep": "error",
    },
  },
];
