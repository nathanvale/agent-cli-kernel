import { kernelLint } from "../kernel/config/kernel/eslint.mjs";
import repository from "../eslint-rules.mjs";

export default kernelLint({
  rootDir: new URL("..", import.meta.url).pathname,
  srcDir: "kernel/src",
  testDirs: ["tests/contract3"],
  addons: "all",
  plugin: repository,
});
