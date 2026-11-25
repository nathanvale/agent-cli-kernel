import { staticString } from "./value-trace.mjs";

const fsModulePattern = /^(?:node:)?fs(?:\/promises)?$/;
const isFsSpecifier = (value) =>
  typeof value === "string" && fsModulePattern.test(value);
const allowedBunMembers = new Set([
  "$",
  "spawn",
  "spawnSync",
  "stdin",
  "stdout",
  "stderr",
  "version",
  "revision",
  "env",
  "nanoseconds",
  "hash",
  "CryptoHasher",
  "deepEquals",
  "inspect",
]);
const allowedNonOpeningFsMembers = new Set([
  "constants",
  "lstat",
  "lstatSync",
  "fstat",
  "fstatSync",
  "realpath",
  "realpathSync",
  "access",
  "accessSync",
  "closeSync",
  "fsyncSync",
]);
const globalHolders = new Set(["globalThis", "global", "self"]);
const loaderModules = new Set([
  "module",
  "node:module",
  "process",
  "node:process",
]);
const moduleOnlyLoader = new Set(["module", "node:module"]);
const loaderNames = new Set(["require", "createRequire", "getBuiltinModule"]);
const checkedGlobals = new Set([
  ...globalHolders,
  "Bun",
  "process",
  "require",
  "module",
]);
const staticMemberName = (node) =>
  node.parent.type === "MemberExpression" &&
  node.parent.object === node &&
  !node.parent.computed
    ? node.parent.property.name
    : undefined;
const rootIdentifier = (node) =>
  node.parent.type === "TSQualifiedName" ? rootIdentifier(node.parent) : node;
const isTypePosition = ({ isValueReference, identifier }) => {
  const root = rootIdentifier(identifier);
  if (root.parent.type === "TSImportEqualsDeclaration")
    return root.parent.importKind === "type";
  return (
    isValueReference === false ||
    root !== identifier ||
    identifier.parent.type === "TSTypeQuery"
  );
};
const isTypeOnly = (node) =>
  node.importKind === "type" || node.exportKind === "type";
const isWholeSpecifier = (type) =>
  type === "ImportDefaultSpecifier" || type === "ImportNamespaceSpecifier";
const identifierText = (node) => node.name ?? node.value;
const specifierName = ({ type, imported, local }) => {
  if (isWholeSpecifier(type)) return undefined;
  const name = identifierText(imported ?? local);
  return name === "default" ? undefined : name;
};
const isUnboundValueReference = (reference) =>
  checkedGlobals.has(reference.identifier.name) &&
  !reference.init &&
  !isTypePosition(reference);
const isLoaderSpecifier = (value, name) =>
  moduleOnlyLoader.has(value) || name === undefined || loaderNames.has(name);

function createLoadJudges(context) {
  const report = (node, messageId, data) =>
    context.report({ node, messageId, data });
  const judgeKnownLoad = (node, value) => {
    if (loaderModules.has(value)) return report(node, "loaderReach");
    if (isFsSpecifier(value))
      report(node, "fsImport", { specifier: JSON.stringify(value) });
  };
  const judgeLoad = (node, value) => {
    if (value === undefined) return report(node, "dynamicImport");
    if (value === "bun") return report(node, "dynamicBunReach");
    judgeKnownLoad(node, value);
  };
  const checkLoad = (node) => {
    const call = node.parent;
    if (call.type !== "CallExpression" || call.callee !== node)
      return report(node, "loaderReach");
    judgeLoad(call, staticString(context, call.arguments[0]));
  };
  return { report, judgeLoad, checkLoad };
}

function createGlobalChecker(report, checkLoad) {
  const checkBunGlobal = (node, member) => {
    if (member === undefined) return report(node, "dynamicBunReach");
    if (!allowedBunMembers.has(member))
      report(node.parent, "bunReach", { member });
  };
  const checkProcessOrMeta = (node, member) => {
    if (member === undefined) return report(node, "loaderReach");
    if (loaderNames.has(member)) checkLoad(node.parent);
  };
  const directGlobals = {
    process: checkProcessOrMeta,
    "import.meta": checkProcessOrMeta,
    require: (node) => checkLoad(node),
    module: (node) => report(node, "loaderReach"),
  };
  const checkGlobalHolder = (node, member) => {
    if (member === undefined) return report(node, "dynamicBunReach");
    return checkGlobal(node.parent, member);
  };
  const checkGlobal = (node, name) => {
    const member = staticMemberName(node);
    if (name === "Bun") return checkBunGlobal(node, member);
    if (globalHolders.has(name)) return checkGlobalHolder(node, member);
    if (Object.hasOwn(directGlobals, name)) directGlobals[name](node, member);
  };
  return checkGlobal;
}

const isWholeExport = (node) =>
  node.type === "ExportAllDeclaration" || node.specifiers.length === 0;

function visitNamedSpecifiers(specifiers, each) {
  for (const specifier of specifiers)
    if (!isTypeOnly(specifier)) each(specifier, specifierName(specifier));
}

function walkSpecifiers(node, each) {
  if (isTypeOnly(node)) return;
  if (isWholeExport(node)) return each(node);
  visitNamedSpecifiers(node.specifiers, each);
}

function createSourceChecker(context, allowFsMembers, report, judgeLoad) {
  const checkBunSpecifier = (specifier, name) => {
    if (name === undefined) return report(specifier, "dynamicBunReach");
    if (!allowedBunMembers.has(name))
      report(specifier, "bunReach", { member: name });
  };
  const checkFsSpecifier = (value) => (specifier, name) => {
    if (name === undefined)
      return report(specifier, "fsImport", {
        specifier: JSON.stringify(value),
      });
    if (!allowFsMembers.has(name))
      report(specifier, "fsMember", {
        member: name,
        specifier: JSON.stringify(value),
      });
  };
  const checkFsSource = (node, value) => {
    if (allowFsMembers === undefined) return judgeLoad(node, value);
    walkSpecifiers(node, checkFsSpecifier(value));
  };
  const checkSourceValue = (node, value) => {
    if (value === "bun") return walkSpecifiers(node, checkBunSpecifier);
    if (loaderModules.has(value))
      return walkSpecifiers(node, (specifier, name) => {
        if (isLoaderSpecifier(value, name)) report(specifier, "loaderReach");
      });
    if (isFsSpecifier(value)) checkFsSource(node, value);
  };
  return (node, source) => {
    if (source) checkSourceValue(node, staticString(context, source));
  };
}

function createFsReachVisitor(context, allowFsMembers) {
  const { report, judgeLoad, checkLoad } = createLoadJudges(context);
  const checkGlobal = createGlobalChecker(report, checkLoad);
  const checkSource = createSourceChecker(
    context,
    allowFsMembers,
    report,
    judgeLoad,
  );
  const checkReferences = (references) => {
    for (const reference of references)
      if (isUnboundValueReference(reference))
        checkGlobal(reference.identifier, reference.identifier.name);
  };
  return {
    ImportDeclaration(node) {
      checkSource(node, node.source);
    },
    ExportNamedDeclaration(node) {
      checkSource(node, node.source);
    },
    ExportAllDeclaration(node) {
      checkSource(node, node.source);
    },
    TSImportEqualsDeclaration(node) {
      const { moduleReference } = node;
      if (
        moduleReference.type === "TSExternalModuleReference" &&
        !isTypeOnly(node)
      )
        judgeLoad(node, staticString(context, moduleReference.expression));
    },
    ImportExpression(node) {
      judgeLoad(node, staticString(context, node.source));
    },
    MetaProperty(node) {
      if (node.meta.name === "import") checkGlobal(node, "import.meta");
    },
    "Program:exit"() {
      for (const { references } of context.sourceCode.scopeManager.scopes)
        checkReferences(references);
    },
  };
}

export const rootedFileRules = {
  "state-no-fs-import": {
    meta: {
      type: "problem",
      schema: [],
      messages: {
        fsImport:
          "Files in kernel/src/addons/state outside store.ts and coordination.ts must not import filesystem module {{specifier}}. Repair: route filesystem access through store.ts (using WriteGate for writes) or coordination.ts.",
        dynamicImport:
          "Files in kernel/src/addons/state outside store.ts and coordination.ts must not use a non-static dynamic import that could load a filesystem module. Repair: use a static import of a non-filesystem module, or route filesystem access through store.ts or coordination.ts.",
        bunReach:
          "Files in kernel/src/addons/state outside store.ts and coordination.ts must not use Bun.{{member}}: only Bun members that touch no path are allowed here. Repair: route filesystem access through store.ts (using WriteGate for writes) or coordination.ts.",
        dynamicBunReach:
          'Files in kernel/src/addons/state outside store.ts and coordination.ts may use the Bun object only as Bun.<member> with a plain member name, read from Bun, globalThis.Bun, global.Bun or self.Bun, or as a named import from "bun". An alias, destructuring, spread, computed key, whole-module load of "bun", or bare globalThis, global or self hides which member is used. Repair: write Bun.<member> in place, or route filesystem access through store.ts or coordination.ts.',
        loaderReach:
          'Files in kernel/src/addons/state outside store.ts and coordination.ts may load a module only by a static import, or by calling require, import.meta.require or process.getBuiltinModule directly with a string, and may use process and import.meta only as process.<member> and import.meta.<member>. An alias, a computed key, createRequire, module, or a whole import of "node:module" or "node:process" hides which module is loaded. Repair: write a static import.',
      },
    },
    create(context) {
      return createFsReachVisitor(context, undefined);
    },
  },
  "paths-use-rooted-file": {
    meta: {
      type: "problem",
      schema: [],
      messages: {
        fsImport:
          "Files in kernel/src outside the rooted-file owners must not import filesystem module {{specifier}} whole. Repair: read paths through readRootedFile from kernel/src/shared/rooted-file.ts, or import only allowed non-opening fs members by name.",
        fsMember:
          "Files in kernel/src outside the rooted-file owners must not import {{member}} from {{specifier}}: only fs members that open no path are allowed here. Repair: read paths through readRootedFile from kernel/src/shared/rooted-file.ts.",
        dynamicImport:
          "Files in kernel/src outside the rooted-file owners must not use a non-static dynamic import that could load a filesystem module. Repair: use a static import of a non-filesystem module, or read paths through readRootedFile from kernel/src/shared/rooted-file.ts.",
        bunReach:
          "Files in kernel/src outside the rooted-file owners must not use Bun.{{member}}: only Bun members that touch no path are allowed here. Repair: read paths through readRootedFile from kernel/src/shared/rooted-file.ts.",
        dynamicBunReach:
          'Files in kernel/src outside the rooted-file owners may use the Bun object only as Bun.<member> with a plain member name, read from Bun, globalThis.Bun, global.Bun or self.Bun, or as a named import from "bun". An alias, destructuring, spread, computed key, whole-module load of "bun", or bare globalThis, global or self hides which member is used. Repair: write Bun.<member> in place, or read paths through readRootedFile from kernel/src/shared/rooted-file.ts.',
        loaderReach:
          'Files in kernel/src outside the rooted-file owners may load a module only by a static import, or by calling require, import.meta.require or process.getBuiltinModule directly with a string, and may use process and import.meta only as process.<member> and import.meta.<member>. An alias, a computed key, createRequire, module, or a whole import of "node:module" or "node:process" hides which module is loaded. Repair: write a static import.',
      },
    },
    create(context) {
      return createFsReachVisitor(context, allowedNonOpeningFsMembers);
    },
  },
};
