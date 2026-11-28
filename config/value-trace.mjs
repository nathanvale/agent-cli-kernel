const typeWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
export const bare = (node) =>
  typeWrappers.has(node?.type) ? bare(node.expression) : node;
const literalKey = (node) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? node.quasis[0]?.value.cooked
      : undefined;
export const propertyName = (node, context, depth = 0) =>
  node.computed
    ? context
      ? staticString(context, node.property, depth)
      : literalKey(node.property)
    : node.property.name;
const lookup = (context, node) => {
  for (
    let scope = context.sourceCode.getScope(node);
    scope;
    scope = scope.upper
  )
    if (scope.set.has(node.name)) return scope.set.get(node.name);
};
const moduleObject = (context, source) => {
  const value = staticString(context, source);
  return value === undefined
    ? undefined
    : { module: value.replace(/^node:/, "") };
};
const memberOf = (base, name) => {
  if (base?.module && base.name === undefined) {
    if (base.module === "global" && name === "Bun") return { module: "bun" };
    if (base.module === "fs" && name === "promises")
      return { module: "fs/promises" };
    if (name === "default") return { module: base.module };
    return { module: base.module, name };
  }
  return { name };
};
const definitionTracers = {
  ImportBinding: (def) => {
    const source = def.parent.source ?? def.node.moduleReference?.expression;
    if (typeof source?.value !== "string") return undefined;
    const mod = source.value.replace(/^node:/, "");
    const name =
      def.node.type === "ImportSpecifier"
        ? (def.node.imported.name ?? def.node.imported.value)
        : undefined;
    if (mod === "fs" && name === "promises") return { module: "fs/promises" };
    if (name === "default") return { module: mod };
    return { module: mod, name };
  },
  Variable: (def, node, next, context) => {
    const { id, init } = def.node;
    if (id === def.name) return next(init) ?? { name: node.name };
    const property = id.properties?.find(
      ({ type, value }) =>
        type === "Property" && (value.left ?? value) === def.name,
    );
    if (!property) return { name: node.name };
    const { key, computed } = property;
    return memberOf(
      next(init),
      computed
        ? staticString(context, key)
        : key.type === "Literal"
          ? key.value
          : key.name,
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
  return (
    definitionTracers[def.type]?.(def, node, next, context) ?? {
      name: node.name,
    }
  );
};
const tracers = {
  Identifier: traceIdentifier,
  MemberExpression: (node, next, context) => {
    const name = propertyName(node, context);
    return typeof name === "string"
      ? memberOf(next(node.object), name)
      : undefined;
  },
  CallExpression: (node, _next, context) =>
    node.callee.type === "Identifier" && node.callee.name === "require"
      ? moduleObject(context, node.arguments[0])
      : undefined,
  ImportExpression: (node, _next, context) =>
    moduleObject(context, node.source),
  AwaitExpression: (node, next) => next(node.argument),
  ChainExpression: (node, next) => next(node.expression),
  SequenceExpression: (node, next) => next(node.expressions.at(-1)),
};
export const origin = (context, node, depth = 0) => {
  const inner = bare(node);
  return inner && depth < 8
    ? tracers[inner.type]?.(
        inner,
        (next) => origin(context, next, depth + 1),
        context,
      )
    : undefined;
};
const staticTemplate = (context, node, depth) => {
  const head = node.quasis[0]?.value.cooked;
  if (typeof head !== "string") return undefined;
  let out = head;
  for (let index = 0; index < node.expressions.length; index++) {
    const part = staticString(context, node.expressions[index], depth + 1);
    const tail = node.quasis[index + 1]?.value.cooked;
    if (part === undefined || typeof tail !== "string") return undefined;
    out += part + tail;
  }
  return out;
};
const comma = { type: "Literal", value: "," };
const foldAll = (context, nodes, depth) => {
  const parts = nodes.map((node) => staticString(context, node, depth));
  return parts.includes(undefined) ? undefined : parts;
};
const staticFolders = {
  Literal: (_context, node) =>
    typeof node.value === "string" ? node.value : undefined,
  TemplateLiteral: staticTemplate,
  BinaryExpression: (context, node, depth) => {
    if (node.operator !== "+") return undefined;
    const left = staticString(context, node.left, depth + 1);
    const right = staticString(context, node.right, depth + 1);
    return left !== undefined && right !== undefined ? left + right : undefined;
  },
  CallExpression: (context, { callee, arguments: args }, depth) => {
    if (
      callee.type !== "MemberExpression" ||
      callee.object.type !== "ArrayExpression" ||
      propertyName(callee, context, depth + 1) !== "join"
    )
      return undefined;
    const parts = foldAll(
      context,
      [...args, comma, ...callee.object.elements],
      depth + 1,
    );
    return parts?.slice(args.length + 1).join(parts[0]);
  },
  Identifier: (context, node, depth) => {
    const def = lookup(context, node)?.defs[0];
    return def?.type === "Variable" &&
      def.parent?.kind === "const" &&
      def.node.id === def.name
      ? staticString(context, def.node.init, depth + 1)
      : undefined;
  },
};
export const staticString = (context, node, depth = 0) => {
  const inner = bare(node);
  return inner && depth < 8
    ? staticFolders[inner.type]?.(context, inner, depth)
    : undefined;
};
