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
    files: ["kernel/src/addons/state/**/*.{ts,mts,cts}"],
    ignores: [
      "kernel/src/addons/state/store.ts",
      "kernel/src/addons/state/coordination.ts",
    ],
    plugins: { repository },
    rules: {
      "repository/state-no-fs-import": "error",
    },
  },
  {
    files: ["kernel/src/**/*.{ts,mts,cts}"],
    ignores: [
      "kernel/src/addons/programs/*.ts",
      "kernel/src/addons/state/*.ts",
      "kernel/src/kernel/state-seam.ts",
      "kernel/src/shared/error-code.ts",
      "kernel/src/shared/rooted-file.ts",
      "kernel/src/addons/approval/store.ts",
      "kernel/src/addons/diagnostics/custody.ts",
      "kernel/src/addons/diagnostics/io.ts",
      "kernel/src/addons/diagnostics/run.ts",
      "kernel/src/kernel/process-host.ts",
    ],
    plugins: { repository },
    rules: {
      "repository/paths-use-rooted-file": "error",
    },
  },
  {
    files: ["tests/kernel/**/*.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/require-to-throw-message": "error",
      "repository/tests-use-test-folder": "error",
      "repository/tests-no-sleep": "error",
      "repository/tests-use-bounded-runner": "error",
      "repository/tests-stub-tools": "error",
    },
  },
];
