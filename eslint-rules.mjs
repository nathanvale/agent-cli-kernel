import { posix } from "node:path";
import ts from "typescript";

const localeNames = new Set(["localeCompare", "Collator"]);
const contractRoot = /^(.*\/starters\/contract3\/src)\//;
const comparisons = new Set(["===", "!==", "==", "!="]);
const folding = new Set(["TemplateLiteral", "BinaryExpression"]);
const comma = { type: "Literal", value: "," };
const ownerKeys = new WeakMap();

// The string a source spells from constants only: literals, + and templates
// over them, [...].join(separator), and const bindings to any of these.
function constantText(context, node, depth = 0) {
  if (!node || depth > 8) return undefined;
  return folders[node.type]?.(context, node, depth + 1);
}

function foldAll(context, nodes, depth) {
  const parts = nodes.map((node) => constantText(context, node, depth));
  return parts.includes(undefined) ? undefined : parts;
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

const folders = {
  Literal: (context, node) =>
    typeof node.value === "string" ? node.value : undefined,
  TemplateLiteral(context, node, depth) {
    const parts = foldAll(context, node.expressions, depth);
    return parts
      ?.map((part, index) => node.quasis[index].value.cooked + part)
      .concat(node.quasis.at(-1).value.cooked)
      .join("");
  },
  BinaryExpression(context, node, depth) {
    if (node.operator !== "+") return undefined;
    return foldAll(context, [node.left, node.right], depth)?.join("");
  },
  CallExpression(context, { callee, arguments: args }, depth) {
    const list = callee.property?.name === "join" ? callee.object : undefined;
    if (list?.type !== "ArrayExpression") return undefined;
    const parts = foldAll(
      context,
      [...args, comma].concat(list.elements),
      depth,
    );
    return parts?.slice(args.length + 1).join(parts[0]);
  },
  Identifier(context, node, depth) {
    const definition = findVariable(
      context.sourceCode.getScope(node),
      node.name,
    )?.defs[0];
    const simple =
      definition?.parent?.kind === "const" &&
      definition.node.id === definition.name;
    return simple
      ? constantText(context, definition.node.init, depth)
      : undefined;
  },
};

// Only the outermost constant expression is judged, so a code built from
// parts is reported once.
function outermost(context, node) {
  return (
    !folding.has(node.parent?.type) ||
    constantText(context, node.parent) === undefined
  );
}

function typeServices(context) {
  const services = context.sourceCode.parserServices;
  return services?.program ? services : undefined;
}

function members(type) {
  return type.isUnion() ? type.types : [type];
}

function closedStrings(type) {
  const parts = members(type);
  const absent = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
  return (
    parts.some((part) => part.isStringLiteral()) &&
    parts.every((part) => part.isStringLiteral() || part.flags & absent)
  );
}

function readCauseKeys(program, checker, path) {
  const declaration = program
    .getSourceFile(path)
    ?.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find(
      (item) => ts.isIdentifier(item.name) && item.name.text === "commonCauses",
    );
  const properties = declaration
    ? checker.getTypeAtLocation(declaration.name).getProperties()
    : [];
  return new Set(properties.map((property) => property.name));
}

function commonCauseKeys(program, checker, path) {
  const cache = ownerKeys.get(program) ?? new Map();
  ownerKeys.set(program, cache);
  if (!cache.has(path)) cache.set(path, readCauseKeys(program, checker, path));
  return cache.get(path);
}

const partners = {
  BinaryExpression: (parent, node) =>
    comparisons.has(parent.operator)
      ? [parent.left, parent.right].find((side) => side !== node)
      : undefined,
  SwitchCase: (parent, node) =>
    parent.test === node ? parent.parent.discriminant : undefined,
};

function ownerImport(context, file, root) {
  const imported = context.sourceCode.scopeManager.scopes.some(
    (scope) => scope.type === "module" && scope.set.has("commonCauses"),
  );
  if (imported) return "";
  const owner = file.startsWith(`${root}/kernel/`) ? "causes.ts" : "index.ts";
  const from = posix.relative(posix.dirname(file), `${root}/kernel/${owner}`);
  return `import type { commonCauses } from "${from.startsWith(".") ? from : `./${from}`}"; `;
}

function camelName(code) {
  return code
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

const causeShape =
  /^(?:SUCCESS|USAGE|SCHEMA|DOMAIN|TRANSIENT|INTERNAL)_[A-Z0-9_]+$/;
const causeOwners = /\/kernel\/(?:causes|state-causes|stations)\.ts$/;
const testFolderOwner = "/tests/support/test-folder.ts";
const folderCalls = new Set(["tmpdir", "mkdtemp", "mkdtempSync"]);
const timerPromises = new Set(["node:timers/promises", "timers/promises"]);
const bunSleeps = new Set(["sleep", "sleepSync"]);
const typeWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
const bare = (node) =>
  typeWrappers.has(node?.type) ? bare(node.expression) : node;
const isUndefined = (node) =>
  (node.type === "Identifier" && node.name === "undefined") ||
  (node.type === "UnaryExpression" && node.operator === "void");
const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";
const onlyCall = ({ body }) => {
  const expression =
    body.type === "BlockStatement"
      ? body.body.length === 1 && body.body[0].expression
      : body;
  return expression?.type === "CallExpression" ? expression : undefined;
};
const propertyName = (node) =>
  node.computed
    ? typeof node.property.value === "string"
      ? node.property.value
      : undefined
    : node.property.name;
const lookup = (context, node) => {
  for (
    let scope = context.sourceCode.getScope(node);
    scope;
    scope = scope.upper
  )
    if (scope.set.has(node.name)) return scope.set.get(node.name);
};
const moduleObject = (source) =>
  typeof source?.value === "string"
    ? { module: source.value.replace(/^node:/, "") }
    : undefined;
const memberOf = (base, name) =>
  base?.module && base.name === undefined
    ? { module: base.module, name }
    : { name };
const definitionTracers = {
  ImportBinding: (def) => ({
    module: def.parent.source.value.replace(/^node:/, ""),
    name:
      def.node.type === "ImportSpecifier"
        ? (def.node.imported.name ?? def.node.imported.value)
        : undefined,
  }),
  Variable: (def, node, next) => {
    const { id, init } = def.node;
    if (id === def.name) return next(init) ?? { name: node.name };
    const property = id.properties?.find(
      ({ value }) => (value.left ?? value) === def.name,
    );
    if (!property) return { name: node.name };
    const { key, computed } = property;
    return memberOf(
      next(init),
      key.type === "Literal" ? key.value : computed ? undefined : key.name,
    );
  },
};
const traceIdentifier = (node, next, context) => {
  const def = lookup(context, node)?.defs[0];
  if (!def)
    return node.name === "globalThis"
      ? { module: "global" }
      : node.name === "Bun"
        ? { module: "bun" }
        : { module: "global", name: node.name };
  return definitionTracers[def.type]?.(def, node, next) ?? { name: node.name };
};
// What an expression names: the module it came from ("global" for a
// global) and the export, or only a name when the origin is not traced. A
// result with no name is the module object itself.
const tracers = {
  Identifier: traceIdentifier,
  MemberExpression: (node, next) => {
    const name = propertyName(node);
    return typeof name === "string"
      ? memberOf(next(node.object), name)
      : undefined;
  },
  CallExpression: (node) =>
    node.callee.type === "Identifier" && node.callee.name === "require"
      ? moduleObject(node.arguments[0])
      : undefined,
  ImportExpression: (node) => moduleObject(node.source),
  AwaitExpression: (node, next) => next(node.argument),
  ChainExpression: (node, next) => next(node.expression),
  SequenceExpression: (node, next) => next(node.expressions.at(-1)),
};
const origin = (context, node, depth = 0) => {
  const inner = bare(node);
  return inner && depth < 8
    ? tracers[inner.type]?.(
        inner,
        (next) => origin(context, next, depth + 1),
        context,
      )
    : undefined;
};
const isTimer = (traced, name) =>
  traced?.name === name &&
  (traced.module === "global" || traced.module === "timers");
const executorResolve = (context, node) =>
  context.sourceCode
    .getAncestors(node)
    .findLast(
      (ancestor) =>
        isFunction(ancestor) &&
        ancestor.parent.type === "NewExpression" &&
        ancestor.parent.callee.name === "Promise" &&
        ancestor.parent.arguments[0] === ancestor,
    )?.params[0]?.name;
const noValue = (values) =>
  values.length === 0 || (values.length === 1 && isUndefined(bare(values[0])));
const resolves = ([wrapped, , ...values], resolve) => {
  const callback = bare(wrapped);
  if (callback?.type === "Identifier")
    return callback.name === resolve && noValue(values);
  const call = isFunction(callback) ? onlyCall(callback) : undefined;
  return call?.callee.name === resolve && noValue(call.arguments);
};
// A delay resolves with no value: it passes the executor's resolve with no
// extra argument, or calls resolve() or resolve(undefined). A watchdog
// rejects, aborts or resolves with a value.
const delays = (context, node) => {
  const resolve = executorResolve(context, node);
  return resolve !== undefined && resolves(node.arguments, resolve);
};
// A pattern that matches a lone NUL character matches every message.
const namesNothing = (wrapped) => {
  const node = bare(wrapped);
  return (
    isUndefined(node) ||
    (node.type === "Literal" && node.value === "") ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis[0].value.cooked === "") ||
    (node.regex !== undefined &&
      new RegExp(node.regex.pattern, node.regex.flags).test("\0"))
  );
};

export default {
  rules: {
    "no-locale-compare": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          locale:
            "localeCompare and Intl.Collator tie distinct keys and follow the runtime collation. Compare code units with < and >. Fix: (a, b) => (a < b ? -1 : a > b ? 1 : 0)",
        },
      },
      create(context) {
        const report = (node, name) => {
          if (localeNames.has(name))
            context.report({ node, messageId: "locale" });
        };
        const constant = (node) => {
          if (outermost(context, node))
            report(node, constantText(context, node));
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
        };
      },
    },
    "no-in-operator": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          in: "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString. Read own data as unknown. Fix: const ownValue: unknown = Object.hasOwn({{target}}, {{key}}) ? Reflect.get({{target}}, {{key}}) : undefined;",
          forIn:
            "for...in also walks inherited enumerable keys. Walk own keys. Fix: for (const key of Object.keys({{target}}))",
        },
      },
      create(context) {
        const services = typeServices(context);
        if (!services) return {};
        const checker = services.program.getTypeChecker();
        const text = (node) => context.sourceCode.getText(node);
        // A key every union member leaves undeclared is a probe of unknown
        // shape. Narrowing a union by a key one member declares is not.
        const declared = (keyNode, targetNode) => {
          const keys = members(services.getTypeAtLocation(keyNode));
          const targets = members(services.getTypeAtLocation(targetNode)).map(
            (type) => checker.getApparentType(type),
          );
          return keys.every(
            (key) =>
              key.isStringLiteral() &&
              targets.some((type) =>
                checker.getPropertyOfType(type, key.value),
              ),
          );
        };
        const check = (node, keyNode, targetNode, how) => {
          if (!declared(keyNode, targetNode))
            context.report({
              node,
              messageId: "in",
              data: { key: text(keyNode), target: text(targetNode), how },
            });
        };
        return {
          "BinaryExpression[operator='in']:not([left.type='PrivateIdentifier'])"(
            node,
          ) {
            check(node, node.left, node.right, "the in operator");
          },
          "CallExpression[callee.object.name='Reflect'][callee.property.name='has'][arguments.length=2]"(
            node,
          ) {
            check(node, node.arguments[1], node.arguments[0], "Reflect.has");
          },
          ForInStatement(node) {
            context.report({
              node,
              messageId: "forIn",
              data: { target: text(node.right) },
            });
          },
        };
      },
    },
    "cause-literal-owner": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          free: 'Cause code "{{code}}" is a free string here, so a renamed or removed code still compiles. Type it with the owner\'s keys and use {{name}} in its place. Fix: {{imports}}const {{name}}: keyof typeof commonCauses = "{{code}}";',
        },
      },
      create(context) {
        const file = context.filename.replaceAll("\\", "/");
        const root = contractRoot.exec(file)?.[1];
        const services = typeServices(context);
        if (!root || !services || causeOwners.test(file)) return {};
        const checker = services.program.getTypeChecker();
        const keys = commonCauseKeys(
          services.program,
          checker,
          `${root}/kernel/causes.ts`,
        );
        const closed = (node) =>
          node !== undefined && closedStrings(services.getTypeAtLocation(node));
        // The compiler already ties a literal whose place, or whose
        // comparison partner, accepts only listed string literals.
        const tied = (node) => {
          const contextual = checker.getContextualType(
            services.esTreeNodeToTSNodeMap.get(node),
          );
          return (
            (contextual !== undefined && closedStrings(contextual)) ||
            closed(partners[node.parent.type]?.(node.parent, node))
          );
        };
        const judged = (node) =>
          node.parent?.type !== "TSLiteralType" && outermost(context, node);
        const causeAt = (node) => {
          const code = judged(node) ? constantText(context, node) : undefined;
          return keys.has(code) && causeShape.test(code) && !tied(node)
            ? code
            : undefined;
        };
        const imports = ownerImport(context, file, root);
        const check = (node) => {
          const code = causeAt(node);
          if (code)
            context.report({
              node,
              messageId: "free",
              data: { code, name: camelName(code), imports },
            });
        };
        return {
          Literal: check,
          TemplateLiteral: check,
          "BinaryExpression[operator='+']": check,
          "CallExpression[callee.property.name='join']": check,
        };
      },
    },
    "require-to-throw-message": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          bare: 'Pass the message or the cause that the test\'s name gives, as in .toThrow("Duplicate command identity."). A bare {{name}}() stays green when another guard refuses.',
          empty:
            'Pass the message or the cause that the test\'s name gives, as in .toThrow("Duplicate command identity."). {{name}}({{argument}}) names no message, so it stays green when another guard refuses.',
        },
      },
      create(context) {
        return {
          "CallExpression > MemberExpression.callee[property.name=/^toThrow(?:Error)?$/]:not([object.property.name='not'])"(
            node,
          ) {
            const [argument] = node.parent.arguments;
            if (argument && !namesNothing(argument)) return;
            context.report({
              node: node.property,
              messageId: argument ? "empty" : "bare",
              data: {
                name: node.property.name,
                argument: argument && context.sourceCode.getText(argument),
              },
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
          CallExpression({ callee }) {
            const name = origin(context, callee)?.name;
            if (folderCalls.has(name))
              context.report({
                node:
                  callee.type === "MemberExpression" ? callee.property : callee,
                messageId: "folder",
                data: { name },
              });
          },
        };
      },
    },
    "tests-no-sleep": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          sleep:
            "Wait on the event the test is about: a ready file, a ledger line, a barrier or the process exit, or drive the fake clock in tests/contract3/lifecycle/recording-host.ts. {{what}} waits on wall time, so the test passes on a fast host and fails on a loaded one. To bound a wait, race the event against a setTimeout that rejects or aborts.",
        },
      },
      create(context) {
        const report = (node, what) =>
          context.report({ node, messageId: "sleep", data: { what } });
        return {
          "MemberExpression, CallExpression > Identifier.callee"(node) {
            const traced = origin(context, node);
            if (traced?.module === "bun" && bunSleeps.has(traced.name))
              report(node, `Bun.${traced.name}`);
          },
          "ImportSpecifier[imported.name='setTimeout']"(node) {
            if (timerPromises.has(node.parent.source.value))
              report(node, "The node:timers/promises setTimeout");
          },
          "ImportDefaultSpecifier, ImportNamespaceSpecifier"(node) {
            if (timerPromises.has(node.parent.source.value))
              report(node, "The node:timers/promises module");
          },
          "ImportExpression, CallExpression[callee.name='require']"(node) {
            if (origin(context, node)?.module === "timers/promises")
              report(node, "The node:timers/promises module");
          },
          CallExpression(node) {
            if (
              isTimer(origin(context, node.callee), "setTimeout") &&
              delays(context, node)
            )
              report(node, "A promise that setTimeout only resolves");
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
