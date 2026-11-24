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
export const programStartMessage =
  "Contract 3 source starts programs only through the programs add-on.";
const outputMessage =
  "Return domain data to the CLI output owner instead of accessing process streams.";
const streams = new Set(["stdout", "stderr"]);
const streamOwners = new Set(["process", "Bun"]);
const runtimeGlobals = {
  Bun: "program",
  process: "output",
  console: "output",
  globalThis: "output",
  global: "output",
  self: "output",
};
const globalHolders = new Set(["globalThis", "global", "self"]);
const bunStartMembers = new Set(["spawn", "spawnSync", "$"]);
const runtimeModules = [
  [/^((node:)?child_process|bun)$/, "program"],
  [/^(node:)?process$/, "output"],
];

function staticKey(node, computed = true) {
  if (!computed) return node.name;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  return undefined;
}

function moduleKind(node) {
  const name = node && staticKey(node);
  return runtimeModules.find(([pattern]) => pattern.test(name))?.[1];
}

function loadedKind(source) {
  return /child_process$/.test(staticKey(source))
    ? undefined
    : moduleKind(source);
}

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
        messages: { output: outputMessage },
      },
      create(context) {
        const report = (node) => context.report({ node, messageId: "output" });
        const owned = (owner, key) =>
          streamOwners.has(owner?.name) && streams.has(key);
        return {
          ImportSpecifier(node) {
            const source = node.parent.source.value;
            if (
              ["node:process", "process", "bun"].includes(source) &&
              streams.has(node.imported.name ?? node.imported.value)
            )
              report(node);
          },
          MemberExpression(node) {
            if (owned(node.object, staticKey(node.property, node.computed)))
              report(node);
          },
          "ObjectPattern > Property"(node) {
            const { parent } = node.parent;
            if (
              owned(
                parent.init ?? parent.right,
                staticKey(node.key, node.computed),
              )
            )
              report(node);
          },
        };
      },
    },
    "no-process-reach": {
      meta: {
        type: "problem",
        schema: [],
        messages: { program: programStartMessage, output: outputMessage },
      },
      create(context) {
        const report = (node, messageId) =>
          messageId && context.report({ node, messageId });
        const runtimeKey = (key) =>
          Object.hasOwn(runtimeGlobals, key) ? runtimeGlobals[key] : undefined;
        const loader = (member) => {
          const call = member.parent;
          const called =
            call.type === "CallExpression" && call.callee === member;
          const source = called ? call.arguments[0] : undefined;
          if (source && staticKey(source) !== undefined)
            report(call, moduleKind(source));
          else report(member, "program");
        };
        const pattern = (parent, identifier) =>
          parent.init === identifier && parent.id.type === "ObjectPattern"
            ? parent.id
            : parent.right === identifier &&
                parent.left.type === "ObjectPattern"
              ? parent.left
              : undefined;
        const memberUse = (member, name) => {
          const key = staticKey(member.property, member.computed);
          if (key === undefined) report(member, runtimeGlobals[name]);
          else if (globalHolders.has(name)) report(member, runtimeKey(key));
          else if (name === "process" && key === "getBuiltinModule")
            loader(member);
        };
        const patternUse = (properties, name) => {
          for (const property of properties) {
            const key =
              property.key && staticKey(property.key, property.computed);
            if (property.type === "RestElement" || key === undefined)
              report(property, runtimeGlobals[name]);
            else if (globalHolders.has(name)) report(property, runtimeKey(key));
          }
        };
        const typeUse = (parent) =>
          ["TSTypeQuery", "TSQualifiedName"].includes(parent.type) ||
          parent.operator === "typeof";
        const judge = (identifier, name) => {
          const { parent } = identifier;
          const destructured = pattern(parent, identifier);
          if (
            parent.type === "MemberExpression" &&
            parent.object === identifier
          )
            memberUse(parent, name);
          else if (destructured) patternUse(destructured.properties, name);
          else if (!typeUse(parent)) report(identifier, runtimeGlobals[name]);
        };
        return {
          ImportDeclaration(node) {
            if (node.importKind === "type") return;
            const kind = loadedKind(node.source);
            for (const specifier of node.specifiers)
              if (specifier.type !== "ImportSpecifier") report(specifier, kind);
              else if (
                node.source.value === "bun" &&
                specifier.importKind !== "type" &&
                bunStartMembers.has(
                  specifier.imported.name ?? specifier.imported.value,
                )
              )
                report(specifier, "program");
          },
          ImportExpression(node) {
            report(node, loadedKind(node.source));
          },
          "Program:exit"(program) {
            const scope = context.sourceCode.getScope(program);
            for (const name of Object.keys(runtimeGlobals)) {
              const references =
                scope.set.get(name)?.references ??
                scope.through.filter(
                  ({ identifier }) => identifier.name === name,
                );
              for (const { identifier } of references) judge(identifier, name);
            }
          },
        };
      },
    },
    "typescript-source": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          source:
            "Source is TypeScript (.ts, .mts or .cts). Repair: write this file as .ts, .mts or .cts.",
        },
      },
      create(context) {
        return {
          Program(node) {
            context.report({ node, messageId: "source" });
          },
        };
      },
    },
  },
};
