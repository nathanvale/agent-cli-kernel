import { posix } from "node:path";
import ts from "typescript";

const localeNames = new Set(["localeCompare", "Collator"]);
const contractRoot = /^(.*\/starters\/contract3\/src)\//;
const comparisons = new Set(["===", "!==", "==", "!="]);
const folding = new Set(["TemplateLiteral", "BinaryExpression"]);
const comma = { type: "Literal", value: "," };
const prototypeOwners = new Set([
  "Object",
  "Function",
  "CallableFunction",
  "NewableFunction",
]);
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
  return ` Import the owner once: import type { commonCauses } from "${from.startsWith(".") ? from : `./${from}`}";`;
}

const causeShape =
  /^(?:SUCCESS|USAGE|SCHEMA|DOMAIN|TRANSIENT|INTERNAL)_[A-Z0-9_]+$/;
const causeOwners = /\/kernel\/(?:causes|state-causes|stations)\.ts$/;

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
          in: "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString. Read the own value into a place typed unknown. Fix: (Object.hasOwn({{target}}, {{key}}) ? Reflect.get({{target}}, {{key}}) : undefined)",
          forIn:
            "for...in also walks inherited enumerable keys. Walk own keys. Fix: for (const key of Object.keys({{target}}))",
        },
      },
      create(context) {
        const services = typeServices(context);
        if (!services) return {};
        const { program } = services;
        const checker = program.getTypeChecker();
        const text = (node) => context.sourceCode.getText(node);
        // Every object type resolves the Object.prototype members, and
        // every function type the Function.prototype ones, so a key found
        // only there is inherited, not declared.
        const inherited = (declaration) =>
          ts.isInterfaceDeclaration(declaration.parent) &&
          prototypeOwners.has(declaration.parent.name.text) &&
          program.isSourceFileDefaultLibrary(declaration.getSourceFile());
        const own = (symbol) =>
          symbol !== undefined &&
          !(
            symbol.declarations?.length && symbol.declarations.every(inherited)
          );
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
                own(checker.getPropertyOfType(type, key.value)),
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
          free: 'Cause code "{{code}}" is a free string here, so a renamed or removed code still compiles. Check it against the owner\'s keys where it stands.{{imports}} Fix: ("{{code}}" satisfies keyof typeof commonCauses)',
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
              data: { code, imports },
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
