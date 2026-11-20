import { kernelLint } from "../kernel/config/kernel/eslint.mjs";
import repository from "../eslint-rules.mjs";
import platformRules from "./platform-rules.mjs";

const skill = "skills/verify-cli";
const kernelFreeCheck = `${skill}/verify.ts`;
const kernelPackage = /^agent-cli-kernel(\/|$)/;
const kernelFreeReason =
  "The kernel-free check judges the installed kernel from outside, so no kernel code may run in its process: it imports agent-cli-kernel in a child, and starts its children and writes its own streams directly.";

function sourceOf(node) {
  const source = node.source;
  if (source?.type === "Literal" && typeof source.value === "string")
    return source.value;
  if (source?.type === "TemplateLiteral" && source.expressions.length === 0)
    return source.quasis[0]?.value.cooked ?? null;
  return null;
}

const kernelFreeRules = {
  rules: {
    "no-kernel-import": {
      meta: {
        type: "problem",
        schema: [],
        messages: { kernel: kernelFreeReason },
      },
      create(context) {
        const judge = (node) => {
          const source = sourceOf(node);
          if (source !== null && kernelPackage.test(source))
            context.report({ node, messageId: "kernel" });
        };
        return {
          ImportDeclaration: judge,
          ExportNamedDeclaration: judge,
          ExportAllDeclaration: judge,
          ImportExpression: judge,
        };
      },
    },
  },
};

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
  {
    files: [kernelFreeCheck],
    plugins: { "kernel-free": kernelFreeRules },
    rules: {
      "no-restricted-properties": "off",
      "repository/no-domain-output": "off",
      "kernel-free/no-kernel-import": "error",
    },
  },
];
