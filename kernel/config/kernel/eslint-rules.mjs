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
const programStartMessage =
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
  require: "program",
};
const globalHolders = new Set(["globalThis", "global", "self"]);
const bunStartMembers = new Set(["spawn", "spawnSync", "$"]);
const allowedRuntimeMembers = {
  Bun: new Set(
    "version revision main env argv which file write stdin sleep sleepSync nanoseconds hash CryptoHasher password deepEquals deepMatch inspect peek semver Glob Transpiler fileURLToPath pathToFileURL resolveSync stringWidth escapeHTML randomUUIDv7 gzipSync gunzipSync deflateSync inflateSync readableStreamToText readableStreamToJSON readableStreamToBytes readableStreamToArrayBuffer ArrayBufferSink color TOML isMainThread".split(
      " ",
    ),
  ),
  process: new Set(
    "env argv argv0 execArgv execPath exit exitCode pid ppid platform arch version versions release cwd uptime hrtime memoryUsage cpuUsage resourceUsage listeners listenerCount nextTick kill getuid geteuid getgid getegid getgroups umask title stdin features isBun revision".split(
      " ",
    ),
  ),
  console: new Set(),
  child_process: new Set(),
  module: new Set(),
};
const runtimeModules = new Map(
  Object.keys(allowedRuntimeMembers).map((owner) => [
    owner.toLowerCase(),
    owner,
  ]),
);

function staticKey(node, computed = true) {
  if (!node) return undefined;
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal")
    return typeof node.value === "string" ? node.value : undefined;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  return undefined;
}

function isAllowedRuntimeMember(owner, key, route) {
  if (allowedRuntimeMembers[owner].has(key)) return true;
  if (route === "export") return false;
  if (owner === "console") return route === "member";
  return (
    (streamOwners.has(owner) && streams.has(key)) ||
    (route !== "import" && owner === "Bun" && bunStartMembers.has(key))
  );
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
            if (node.importKind === "type" || node.parent.importKind === "type")
              return;
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
        const chainableProcess = new Set(
          "on once off addListener removeListener removeAllListeners prependListener prependOnceListener setMaxListeners".split(
            " ",
          ),
        );
        const report = (node, owner) =>
          context.report({
            node,
            messageId: (owner && runtimeGlobals[owner]) || "program",
          });
        const ownerOf = (source) => {
          const name = source && staticKey(source);
          return typeof name === "string"
            ? runtimeModules.get(name.replace(/^node:/, ""))
            : undefined;
        };
        const typeOnly = (node) =>
          node.importKind === "type" || node.exportKind === "type";
        const specifierAdmitted = (specifier, owner, route) => {
          const name = specifier.imported ?? specifier.local;
          return (
            typeOnly(specifier) ||
            (["ImportSpecifier", "ExportSpecifier"].includes(specifier.type) &&
              isAllowedRuntimeMember(owner, name.name ?? name.value, route))
          );
        };
        const specifiersUse = (node, route) => {
          const owner = ownerOf(node.source);
          if (!owner || owner === "child_process") return;
          if (typeOnly(node) && (owner !== "module" || route === "import"))
            return;
          if (
            (owner === "module" && route === "export") ||
            !node.specifiers?.length
          )
            return report(node, owner);
          for (const specifier of node.specifiers)
            if (!specifierAdmitted(specifier, owner, route))
              report(specifier, owner);
        };
        const load = (node, source) => {
          const owner = ownerOf(source);
          if (owner || !source || staticKey(source) === undefined)
            report(node, owner);
        };
        const pattern = (parent, identifier) =>
          parent?.type === "VariableDeclarator" &&
          parent.init === identifier &&
          parent.id.type === "ObjectPattern"
            ? parent.id
            : ["AssignmentExpression", "AssignmentPattern"].includes(
                  parent?.type,
                ) &&
                parent.right === identifier &&
                parent.left.type === "ObjectPattern"
              ? parent.left
              : undefined;
        const discardedCall = (member) => {
          const call = member.parent;
          const outer =
            call?.parent?.type === "ChainExpression" ? call.parent : call;
          return (
            call?.type === "CallExpression" &&
            call.callee === member &&
            (outer.parent?.type === "ExpressionStatement" ||
              outer.parent?.operator === "void")
          );
        };
        const refused = (name, key, route) =>
          globalHolders.has(name)
            ? Object.hasOwn(runtimeGlobals, key)
            : !isAllowedRuntimeMember(name, key, route);
        const memberUse = (member, name, ambient) => {
          const key = staticKey(member.property, member.computed);
          if (name === "process" && chainableProcess.has(key)) {
            if (!discardedCall(member)) report(member, name);
            return;
          }
          if (
            key === undefined ||
            (ambient && name === "console") ||
            refused(name, key, "member")
          )
            report(member, globalHolders.has(name) && key ? key : name);
        };
        const patternUse = (properties, name) => {
          for (const property of properties) {
            const key =
              property.key && staticKey(property.key, property.computed);
            if (
              property.type === "RestElement" ||
              key === undefined ||
              (name === "import.meta"
                ? property.computed || key === "require"
                : refused(name, key, "pattern"))
            )
              report(property, globalHolders.has(name) && key ? key : name);
          }
        };
        const typeUse = (parent) =>
          Boolean(parent) &&
          (["TSTypeQuery", "TSQualifiedName"].includes(parent.type) ||
            parent.operator === "typeof");
        const directLoad = (callee) => {
          const call = callee.parent;
          if (call?.type === "CallExpression" && call.callee === callee)
            load(call, call.arguments[0]);
          else if (!typeUse(call)) report(callee, "require");
        };
        const isAmbient = (def) => {
          if (def.type === "Type" || def.type === "TypeParameter") return true;
          for (let node = def.node; node; node = node.parent)
            if (node.declare || typeOnly(node)) return true;
          return false;
        };
        const judge = (identifier, name, ambient) => {
          const { parent } = identifier;
          if (name === "require") return directLoad(identifier);
          const destructured = pattern(parent, identifier);
          if (
            parent?.type === "MemberExpression" &&
            parent.object === identifier
          )
            memberUse(parent, name, ambient);
          else if (destructured) patternUse(destructured.properties, name);
          else if (!typeUse(parent)) report(identifier, name);
        };
        return {
          ImportDeclaration: (node) => specifiersUse(node, "import"),
          ExportNamedDeclaration: (node) =>
            node.source && specifiersUse(node, "export"),
          ExportAllDeclaration: (node) => specifiersUse(node, "export"),
          ImportExpression: (node) => load(node, node.source),
          MetaProperty(node) {
            if (node.meta.name !== "import") return;
            const { parent } = node;
            const destructured = pattern(parent, node);
            if (parent?.type === "MemberExpression" && parent.object === node) {
              if (parent.computed) report(parent, "require");
              else if (parent.property.name === "require") directLoad(parent);
            } else if (destructured)
              patternUse(destructured.properties, "import.meta");
            else if (!typeUse(parent)) report(node, "require");
          },
          "Program:exit"(program) {
            const refs = context.sourceCode
              .getScope(program)
              .through.filter((ref) =>
                Object.hasOwn(runtimeGlobals, ref.identifier.name),
              );
            for (const scope of context.sourceCode.scopeManager.scopes)
              for (const name of Object.keys(runtimeGlobals)) {
                const variable = scope.set.get(name);
                if (variable?.defs.every(isAmbient))
                  refs.push(...variable.references);
              }
            for (const ref of new Set(refs))
              if (!ref.isTypeReference || ref.isValueReference)
                judge(
                  ref.identifier,
                  ref.identifier.name,
                  Boolean(ref.resolved?.defs.length),
                );
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
