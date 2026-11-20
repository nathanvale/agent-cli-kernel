import { kernelLint } from "../kernel/config/kernel/eslint.mjs";
import repository from "../eslint-rules.mjs";
import platformRules from "./platform-rules.mjs";

const skill = "skills/verify-cli";

export const verifySkillPaths = [`${skill}/**`];

export default [
  ...kernelLint({
    rootDir: new URL("..", import.meta.url).pathname,
    srcDir: skill,
    testDirs: [],
    addons: [],
    plugin: repository,
  }),
  {
    files: [`${skill}/**/*.ts`],
    plugins: { repository, platform: platformRules },
    rules: {
      "repository/no-comments": "error",
      "platform/no-host-path-literal": "error",
    },
  },
];
