const causeShape =
  /^(?:SUCCESS|USAGE|SCHEMA|DOMAIN|TRANSIENT|INTERNAL)_[A-Z0-9_]+$/;
const causeOwners = /\/kernel\/(?:causes|state-causes|stations)\.ts$/;
const testFolderOwner = "/tests/support/test-folder.ts";
const folderCalls = new Set(["tmpdir", "mkdtemp", "mkdtempSync"]);

export default {
  rules: {
    "no-locale-compare": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          locale:
            "Compare code units with < and >, as in (a, b) => (a < b ? -1 : a > b ? 1 : 0). localeCompare and Intl.Collator tie distinct keys and follow the runtime collation.",
        },
      },
      create(context) {
        return {
          "MemberExpression[property.name='localeCompare'], MemberExpression[property.value='localeCompare'], MemberExpression[object.name='Intl'][property.name='Collator']"(
            node,
          ) {
            context.report({ node, messageId: "locale" });
          },
        };
      },
    },
    "no-in-operator": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          in: "Check own data with Object.hasOwn on a snapshot of own data, not the in operator, and read the value as unknown: Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined. The in operator also finds Object.prototype members such as toString.",
        },
      },
      create(context) {
        return {
          "BinaryExpression[operator='in']:not([left.type='PrivateIdentifier'])"(
            node,
          ) {
            context.report({ node, messageId: "in" });
          },
        };
      },
    },
    "cause-literal-owner": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          kernel:
            'Cause code "{{code}}" is copied here. Import it from its owner: kernel/causes.ts (commonCauses), kernel/state-causes.ts (deadlineCause, internalResultCause, internalResultCode) or kernel/stations.ts (reservedFallbackCause). If the owner has no export for it, add one there.',
          host: 'Cause code "{{code}}" is copied here. Outside the kernel, read cause data from the kernel public index (kernel/index.ts exports commonCauses), never a restated literal.',
        },
      },
      create(context) {
        const file = context.filename.replaceAll("\\", "/");
        if (causeOwners.test(file)) return {};
        const messageId = file.includes("/kernel/") ? "kernel" : "host";
        const check = (node, code) => {
          if (causeShape.test(code))
            context.report({ node, messageId, data: { code } });
        };
        return {
          ":not(TSLiteralType) > Literal"(node) {
            if (typeof node.value === "string") check(node, node.value);
          },
          "TemplateLiteral[expressions.length=0]"(node) {
            check(node, node.quasis[0].value.cooked);
          },
        };
      },
    },
    "require-to-throw-message": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          bare: 'Pass the message or the cause that the test\'s name gives, as in .toThrow("Duplicate command identity."). A bare {{name}}() stays green when another guard refuses.',
        },
      },
      create(context) {
        return {
          "CallExpression[arguments.length=0] > MemberExpression.callee[property.name=/^toThrow(?:Error)?$/]:not([object.property.name='not'])"(
            node,
          ) {
            context.report({
              node: node.property,
              messageId: "bare",
              data: { name: node.property.name },
            });
          },
        };
      },
    },
    "tests-use-test-folder": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          folder:
            "Make a test folder with testFolder(prefix) from tests/support/test-folder.ts, not {{name}}(). It honours STATE_TEST_DIR, so a run on a chosen filesystem reaches every test folder.",
        },
      },
      create(context) {
        if (context.filename.replaceAll("\\", "/").endsWith(testFolderOwner))
          return {};
        return {
          "CallExpression > Identifier.callee, CallExpression > MemberExpression.callee[computed=false] > Identifier.property"(
            node,
          ) {
            if (folderCalls.has(node.name))
              context.report({
                node,
                messageId: "folder",
                data: { name: node.name },
              });
          },
        };
      },
    },
    "no-domain-output": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          output:
            "Return domain data to the CLI output owner instead of accessing process streams.",
        },
      },
      create(context) {
        return {
          ImportSpecifier(node) {
            if (!["node:process", "process"].includes(node.parent.source.value))
              return;
            if (
              ["stdout", "stderr"].includes(
                node.imported.name ?? node.imported.value,
              )
            )
              context.report({ node, messageId: "output" });
          },
          MemberExpression(node) {
            const property = node.computed
              ? node.property.value
              : node.property.name;
            if (
              node.object.name === "process" &&
              ["stdout", "stderr"].includes(property)
            ) {
              context.report({ node, messageId: "output" });
            }
          },
        };
      },
    },
  },
};
