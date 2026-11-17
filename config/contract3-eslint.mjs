import { kernelLint } from "../starters/contract3/config/kernel/eslint.mjs";
import repository from "../eslint-rules.mjs";

export default kernelLint({
  rootDir: new URL("..", import.meta.url).pathname,
  srcDir: "starters/contract3/src",
  testDirs: ["tests/contract3"],
  addons: "all",
  plugin: repository,
});
