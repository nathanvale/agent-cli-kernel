import { existsSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const localeNames = new Set(["localeCompare", "Collator"]);
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

function stable(node) {
  if (node.type === "Identifier" || node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  return (
    node.type === "MemberExpression" &&
    stable(node.object) &&
    (!node.computed || stable(node.property))
  );
}

function closedStrings(type) {
  const parts = members(type);
  const absent = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
  return (
    parts.some((part) => part.isStringLiteral()) &&
    parts.every((part) => part.isStringLiteral() || part.flags & absent)
  );
}

const kernelSource = fileURLToPath(new URL("../../src", import.meta.url));
const kernelEntry = fileURLToPath(
  new URL("../../src/kernel/index.ts", import.meta.url),
);
const kernelPackage = "agent-cli-kernel";
const ownerOptions = {
  noEmit: true,
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ESNext,
  types: [],
  lib: ["lib.es5.d.ts"],
};

export function holdsKernelSource(folder) {
  return (
    existsSync(folder) && realpathSync(folder) === realpathSync(kernelSource)
  );
}

function exportedCauseKeys(entry) {
  const missing = (why) =>
    new Error(
      `repository/cause-literal-owner cannot learn the cause codes: ${why}. Repair: install ${kernelPackage} at its Pin again, so its entry exports commonCauses.`,
    );
  if (!existsSync(entry)) throw missing(`the kernel entry ${entry} is missing`);
  const program = ts.createProgram({
    rootNames: [entry],
    options: ownerOptions,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  const exported = module
    ? checker
        .getExportsOfModule(module)
        .find(({ name }) => name === "commonCauses")
    : undefined;
  if (exported === undefined)
    throw missing(`${entry} does not export commonCauses`);
  const owner =
    exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported;
  const keys = checker
    .getTypeOfSymbol(owner)
    .getProperties()
    .map(({ name }) => name)
    .filter((name) => causeShape.test(name));
  if (keys.length === 0)
    throw missing(`commonCauses in ${entry} names no cause code`);
  return new Set(keys);
}

function commonCauseKeys(program) {
  if (!ownerKeys.has(program))
    ownerKeys.set(program, exportedCauseKeys(kernelEntry));
  return ownerKeys.get(program);
}

const partners = {
  BinaryExpression: (parent, node) =>
    comparisons.has(parent.operator)
      ? [parent.left, parent.right].find((side) => side !== node)
      : undefined,
  SwitchCase: (parent, node) =>
    parent.test === node ? parent.parent.discriminant : undefined,
};

function ownerImport(context, file, root, installed) {
  const imported = context.sourceCode.scopeManager.scopes.some(
    (scope) => scope.type === "module" && scope.set.has("commonCauses"),
  );
  if (imported) return "";
  const line = (from) =>
    ` Import the owner once: import type { commonCauses } from "${from}";`;
  if (installed) return line(kernelPackage);
  const owner = file.startsWith(`${root}/kernel/`) ? "causes.ts" : "index.ts";
  const from = posix.relative(posix.dirname(file), `${root}/kernel/${owner}`);
  return line(from.startsWith(".") ? from : `./${from}`);
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
            "localeCompare and Intl.Collator tie distinct keys and follow the runtime collation. Compare code units with < and >. Repair: (a, b) => (a < b ? -1 : a > b ? 1 : 0)",
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
          "CallExpression[callee.property.name='join']": constant,
        };
      },
    },
    "no-in-operator": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          in: "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString. Read the own value into a place typed unknown. Repair: (Object.hasOwn({{target}}, {{key}}) ? Reflect.get({{target}}, {{key}}) : undefined)",
          inBound:
            "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString. A second evaluation of {{target}} or {{key}} may yield another value, so bind both once, in the order {{how}} evaluates them, then read the own value into a place typed unknown. Repair: {{bindings}} const own: unknown = Object.hasOwn(target, key) ? Reflect.get(target, key) : undefined;",
          forIn:
            "for...in also walks inherited enumerable keys. Walk own keys. Repair: for (const key of Object.keys({{target}}))",
        },
      },
      create(context) {
        const services = typeServices(context);
        if (!services) return {};
        const { program } = services;
        const checker = program.getTypeChecker();
        const text = (node) => context.sourceCode.getText(node);
        // Platform: Every object type resolves the Object.prototype members, and
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
        const propertyOf = (type, key) => {
          if (key.isStringLiteral() || key.isNumberLiteral())
            return checker.getPropertyOfType(type, String(key.value));
          if (key.flags & ts.TypeFlags.UniqueESSymbol)
            return checker
              .getPropertiesOfType(type)
              .find((property) => property.escapedName === key.escapedName);
          return undefined;
        };
        const declared = (keyNode, targetNode) => {
          const keys = members(services.getTypeAtLocation(keyNode));
          const targets = members(services.getTypeAtLocation(targetNode)).map(
            (type) => checker.getApparentType(type),
          );
          return keys.every((key) =>
            targets.some((type) => own(propertyOf(type, key))),
          );
        };
        const check = (node, keyNode, targetNode, how) => {
          if (declared(keyNode, targetNode)) return;
          const data = { key: text(keyNode), target: text(targetNode), how };
          if (stable(keyNode) && stable(targetNode)) {
            context.report({ node, messageId: "in", data });
            return;
          }
          const key = `const key = ${data.key};`;
          const target = `const target = ${data.target};`;
          const bindings =
            how === "Reflect.has" ? `${target} ${key}` : `${key} ${target}`;
          context.report({
            node,
            messageId: "inBound",
            data: { ...data, bindings },
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
          free: 'Cause code "{{code}}" is a free string here, so a renamed or removed code still compiles. Check it against the owner\'s keys where it stands.{{imports}} Repair: ("{{code}}" satisfies keyof typeof commonCauses)',
        },
      },
      create(context) {
        const file = context.filename.replaceAll("\\", "/");
        const srcDir = context.settings.kernel?.srcDir;
        if (typeof srcDir !== "string")
          throw new Error(
            "repository/cause-literal-owner needs settings.kernel.srcDir. Turn the rule on through kernelLint, which sets it.",
          );
        const root = posix.join(context.cwd.replaceAll("\\", "/"), srcDir);
        if (!file.startsWith(`${root}/`))
          throw new Error(
            `repository/cause-literal-owner lints ${file}, outside ${root}. Run ESLint from the folder that holds eslint.config.mjs.`,
          );
        const installed = !holdsKernelSource(root);
        const services = typeServices(context);
        if (!services || (!installed && causeOwners.test(file))) return {};
        const checker = services.program.getTypeChecker();
        const keys = commonCauseKeys(services.program);
        const ownerTyped = (type) =>
          type !== undefined &&
          closedStrings(type) &&
          [...keys].every((key) =>
            members(type).some(
              (part) => part.isStringLiteral() && part.value === key,
            ),
          );
        const tied = (node) => {
          const partner = partners[node.parent.type]?.(node.parent, node);
          return (
            ownerTyped(
              checker.getContextualType(
                services.esTreeNodeToTSNodeMap.get(node),
              ),
            ) ||
            (partner !== undefined &&
              ownerTyped(services.getTypeAtLocation(partner)))
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
        const imports = ownerImport(context, file, root, installed);
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
