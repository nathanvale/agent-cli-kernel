import { testRules } from "./test-rules.mjs";
import { staticString } from "./value-trace.mjs";

const localeNames = new Set(["localeCompare", "Collator"]);
const folding = new Set(["TemplateLiteral", "BinaryExpression"]);

function outermost(context, node) {
  return (
    !folding.has(node.parent?.type) ||
    staticString(context, node.parent) === undefined
  );
}

export default {
  rules: {
    ...testRules,
    "no-locale-compare": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          locale:
            "localeCompare and Intl.Collator tie distinct keys and follow the runtime collation. Repair: (a, b) => (a < b ? -1 : a > b ? 1 : 0)",
        },
      },
      create(context) {
        const report = (node, name) => {
          if (localeNames.has(name))
            context.report({ node, messageId: "locale" });
        };
        const constant = (node) => {
          if (outermost(context, node))
            report(node, staticString(context, node));
        };
        return {
          "MemberExpression[computed=false]"(node) {
            report(node.property, node.property.name);
          },
          "ObjectPattern > Property[computed=false]"(node) {
            report(node.key, node.key.name);
          },
          Literal: constant,
          TemplateLiteral: constant,
          "BinaryExpression[operator='+']": constant,
          "CallExpression[callee.property.name='join']": constant,
        };
      },
    },
  },
};
