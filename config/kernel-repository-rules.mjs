import { posix } from "node:path";
import kernel from "../kernel/config/kernel/eslint-rules.mjs";
import { bare, origin, propertyName, staticString } from "./value-trace.mjs";

const commentDirective =
  /^(?:eslint-|eslint |global |@ts-|biome-ignore|fallow-ignore)/;
const plainMarkers = ["Platform", "Interface"];
const safetyMarker = "SAFETY";
const commentMarker = new RegExp(`^(?:${plainMarkers.join("|")}):`);
const safetyJustification = new RegExp(`^${safetyMarker}:\\s*\\S`);
const acceptedDecision = /accepted decisions?\b/i;
const castOwners = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);
const testFolderOwner = "/tests/support/test-folder.ts";
const boundedRunnerOwners = [
  "/tests/support/process.ts",
  "/tests/kernel/kernel-repair/swarm-process.ts",
  "/tests/kernel/lifecycle/harness.ts",
];
const bunSpawns = new Set(["spawn", "spawnSync"]);
const childProcessSpawns = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);
const folderCalls = new Set(["tmpdir", "mkdtemp", "mkdtempSync"]);
const linkOrCopyCalls = new Set([
  "symlink",
  "symlinkSync",
  "link",
  "linkSync",
  "copyFile",
  "copyFileSync",
]);
const systemBinaryPath = /^\/(?:usr\/(?:local\/)?)?s?bin\/.+/;
const timerPromises = new Set(["node:timers/promises", "timers/promises"]);
const bunSleeps = new Set(["sleep", "sleepSync"]);
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
const delays = (context, node) => {
  const resolve = executorResolve(context, node);
  return resolve !== undefined && resolves(node.arguments, resolve);
};
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

function commentBlocks(source) {
  const blocks = [];
  for (const comment of source.getAllComments()) {
    const block = blocks[blocks.length - 1];
    const last = block?.[block.length - 1];
    if (
      last?.type === "Line" &&
      comment.type === "Line" &&
      comment.loc.start.line === last.loc.end.line + 1
    )
      block.push(comment);
    else blocks.push([comment]);
  }
  return blocks;
}

function isConstAssertion(node) {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function commentAbove(source, node) {
  const comment = source.getCommentsBefore(node).at(-1);
  return comment?.loc.end.line === node.loc.start.line - 1
    ? comment
    : undefined;
}

function castPlacements(source, assertion) {
  const placements = [];
  let node = assertion;
  while (node.parent) {
    placements.push(commentAbove(source, node));
    if (castOwners.has(node.type)) {
      if (
        node.parent.type === "ExportNamedDeclaration" &&
        node.parent.declaration === node
      )
        placements.push(commentAbove(source, node.parent));
      break;
    }
    if (node.parent.type === "Program") break;
    node = node.parent;
  }
  return placements;
}

function isAdmitted(source, block, placed) {
  const lines = block.map((comment) => comment.value.trim());
  const [first = ""] = lines;
  const { start } = block[0].loc;
  return (
    commentDirective.test(first) ||
    commentMarker.test(first) ||
    acceptedDecision.test(lines.join(" ")) ||
    (safetyJustification.test(first) &&
      source.lines[start.line - 1].slice(0, start.column).trim() === "" &&
      placed.has(block[block.length - 1]))
  );
}

const fsModulePattern = /^(?:node:)?fs(?:\/promises)?$/;
const isFsSpecifier = (value) =>
  typeof value === "string" && fsModulePattern.test(value);
const isRequireCall = (node) =>
  (node.callee.type === "Identifier" && node.callee.name === "require") ||
  (node.callee.type === "MemberExpression" &&
    node.callee.object.type === "MetaProperty" &&
    propertyName(node.callee) === "require") ||
  (node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "process" &&
    propertyName(node.callee) === "getBuiltinModule");
const bunPathFreeMembers = new Set([
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
const globalHolders = new Set(["globalThis", "global", "self"]);
const staticMemberName = (node) =>
  node.parent.type === "MemberExpression" &&
  node.parent.object === node &&
  !node.parent.computed
    ? node.parent.property.name
    : undefined;
const isTypePosition = ({ isValueReference, identifier }) =>
  isValueReference === false ||
  identifier.parent.type === "TSTypeQuery" ||
  identifier.parent.type === "TSQualifiedName";
const globalReferences = ({ through, variables }) => [
  ...through,
  ...variables
    .filter(({ defs }) => defs.length === 0)
    .flatMap(({ references }) => references),
];
const isTypeOnly = (node) =>
  node.importKind === "type" || node.exportKind === "type";
const specifierName = ({ imported, local }) =>
  (imported ?? local).name ?? (imported ?? local).value;

export default {
  rules: {
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
        },
      },
      create(context) {
        const report = (node, messageId, member) =>
          context.report({ node, messageId, data: { member } });
        const checkBunUse = (node) => {
          const member = staticMemberName(node);
          if (member === undefined) report(node, "dynamicBunReach");
          else if (!bunPathFreeMembers.has(member))
            report(node.parent, "bunReach", member);
        };
        const checkHolder = (node) => {
          const member = staticMemberName(node);
          if (member === undefined) report(node, "dynamicBunReach");
          else if (member === "Bun") checkBunUse(node.parent);
          else if (globalHolders.has(member)) checkHolder(node.parent);
        };
        const checkBunImport = (node) => {
          if (isTypeOnly(node)) return;
          if (node.type === "ExportAllDeclaration")
            return report(node, "dynamicBunReach");
          for (const specifier of node.specifiers) {
            const name = specifierName(specifier);
            if (isTypeOnly(specifier)) continue;
            if (
              specifier.type === "ImportDefaultSpecifier" ||
              specifier.type === "ImportNamespaceSpecifier"
            )
              report(specifier, "dynamicBunReach");
            else if (!bunPathFreeMembers.has(name))
              report(specifier, "bunReach", name);
          }
        };
        const checkSource = (node, source) => {
          if (!source) return;
          const value = staticString(context, source);
          if (value === "bun") checkBunImport(node);
          if (isFsSpecifier(value))
            context.report({
              node,
              messageId: "fsImport",
              data: { specifier: JSON.stringify(value) },
            });
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
            if (moduleReference.type !== "TSExternalModuleReference") return;
            const value = staticString(context, moduleReference.expression);
            if (value === "bun" && !isTypeOnly(node))
              report(node, "dynamicBunReach");
            else if (isFsSpecifier(value))
              context.report({
                node,
                messageId: "fsImport",
                data: { specifier: JSON.stringify(value) },
              });
          },
          "Program:exit"() {
            for (const reference of globalReferences(
              context.sourceCode.scopeManager.globalScope,
            )) {
              const { identifier } = reference;
              if (isTypePosition(reference)) continue;
              if (identifier.name === "Bun") checkBunUse(identifier);
              else if (globalHolders.has(identifier.name))
                checkHolder(identifier);
            }
          },
          ImportExpression(node) {
            const value = staticString(context, node.source);
            if (value === undefined)
              context.report({ node, messageId: "dynamicImport" });
            else if (value === "bun") report(node, "dynamicBunReach");
            else if (isFsSpecifier(value))
              context.report({
                node,
                messageId: "fsImport",
                data: { specifier: JSON.stringify(value) },
              });
          },
          CallExpression(node) {
            if (!isRequireCall(node)) return;
            const [first] = node.arguments;
            if (!first) return;
            const value = staticString(context, first);
            if (value === undefined)
              context.report({ node, messageId: "dynamicImport" });
            else if (value === "bun") checkBunUse(node);
            else if (isFsSpecifier(value))
              context.report({
                node,
                messageId: "fsImport",
                data: { specifier: JSON.stringify(value) },
              });
          },
        };
      },
    },
    "no-comments": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          comment:
            "A comment reads as permission, and the next agent builds on it. Keep a comment only when its first word is Platform: (behaviour of a runtime, operating system or tool this repository cannot change) or Interface: (a public contract the types cannot state), or when it cites an accepted decision (AGENTS.md, Authority), or when it opens with SAFETY: and a justification, on its own lines directly above the statement that holds a type cast (as T, not as const). Repair: say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.",
        },
      },
      create(context) {
        const source = context.sourceCode;
        const placed = new Set();
        const collect = (node) => {
          if (!isConstAssertion(node))
            for (const comment of castPlacements(source, node))
              placed.add(comment);
        };
        return {
          TSAsExpression: collect,
          TSTypeAssertion: collect,
          "Program:exit"() {
            for (const block of commentBlocks(source)) {
              if (isAdmitted(source, block, placed)) continue;
              context.report({
                loc: {
                  start: block[0].loc.start,
                  end: block[block.length - 1].loc.end,
                },
                messageId: "comment",
              });
            }
          },
        };
      },
    },
    "require-to-throw-message": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          bare: 'A bare {{name}}() passes whatever is thrown. Repair: pass the message or the cause that the test\'s name gives, as in .toThrow("Duplicate command identity.").',
          empty:
            '{{name}}({{argument}}) names no message, so it passes whatever is thrown. Repair: pass the message or the cause that the test\'s name gives, as in .toThrow("Duplicate command identity.").',
        },
      },
      create(context) {
        return {
          "CallExpression > MemberExpression.callee"(node) {
            const name = propertyName(node);
            if (
              !/^toThrow(?:Error)?$/.test(name) ||
              (node.object.type === "MemberExpression" &&
                propertyName(node.object) === "not")
            )
              return;
            const [argument] = node.parent.arguments;
            if (argument && !namesNothing(argument)) return;
            context.report({
              node: node.property,
              messageId: argument ? "empty" : "bare",
              data: {
                name,
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
            "{{name}}() ignores STATE_TEST_DIR, so a run on a chosen filesystem misses this folder. Repair: make the test folder with testFolder(prefix) from tests/support/test-folder.ts.",
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
            "{{what}} waits on wall time, so the test passes on a fast machine and fails on a loaded one. Repair: wait on the event the test is about (a ready file, a ledger line, a barrier or the process exit), or drive the fake clock in tests/kernel/lifecycle/recording-host.ts. To bound a wait, race the event against a setTimeout that rejects or aborts.",
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
    "tests-use-bounded-runner": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          unbounded:
            "{{what}} starts a child process outside a bounded runner, so a hung child can stall the suite or outlive teardown. Repair: run children through spawnBounded from tests/support/process.ts (template tests) or tests/kernel/kernel-repair/swarm-process.ts, or exitWithin from tests/kernel/lifecycle/harness.ts (kernel tests).",
        },
      },
      create(context) {
        const normalized = context.filename.replaceAll("\\", "/");
        if (boundedRunnerOwners.some((owner) => normalized.endsWith(owner)))
          return {};
        return {
          CallExpression({ callee }) {
            const traced = origin(context, callee);
            const what =
              traced?.module === "bun" && bunSpawns.has(traced.name)
                ? `Bun.${traced.name}()`
                : traced?.module === "child_process" &&
                    childProcessSpawns.has(traced.name)
                  ? `child_process.${traced.name}()`
                  : undefined;
            if (what !== undefined)
              context.report({
                node:
                  callee.type === "MemberExpression" ? callee.property : callee,
                messageId: "unbounded",
                data: { what },
              });
          },
        };
      },
    },
    "tests-stub-tools": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          systemBinary:
            "{{what}} links or copies system binary {{target}} as a fake tool, whose behaviour depends on how the host binary reads argv[0]. Repair: write an executable #!/bin/sh stub script with writeFileSync(..., { mode: 0o755 }) instead.",
        },
      },
      create(context) {
        return {
          CallExpression({ callee, arguments: args }) {
            const traced = origin(context, callee);
            if (
              (traced?.module !== "fs" && traced?.module !== "fs/promises") ||
              !linkOrCopyCalls.has(traced.name)
            )
              return;
            const target = staticString(context, args[0]);
            if (
              target === undefined ||
              !systemBinaryPath.test(posix.normalize(target))
            )
              return;
            context.report({
              node: args[0],
              messageId: "systemBinary",
              data: {
                what: `${traced.module}.${traced.name}()`,
                target: JSON.stringify(target),
              },
            });
          },
        };
      },
    },
    ...kernel.rules,
  },
};
