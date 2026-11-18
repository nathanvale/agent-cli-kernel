const upstream = {
  name: "anti-slop",
  source:
    "https://github.com/dmmulroy/anti-slop/tree/13909c9e07590f5a85d93c62712259fe14a883f7/src",
  licence: `MIT License

Copyright (c) 2026 Dillon Mulroy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
};

const assertionTypes = new Set(["TSAsExpression", "TSTypeAssertion"]);
const assertion = ":matches(TSAsExpression, TSTypeAssertion)";
const outermostAssertion = `${assertion}:not(${assertion} > ${assertion})`;
const constAt = (path) => `[${path}typeAnnotation.typeName.name="const"]`;
const assertionAt = (path) =>
  `[${path}type=/^(?:TSAsExpression|TSTypeAssertion)$/]`;
const chainedMessage =
  "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.";
const chainLevels = [
  "",
  "expression.",
  "expression.expression.",
  "expression.expression.expression.",
];

function chainSelector(constDepth) {
  const consts = chainLevels.slice(0, constDepth).map(constAt).join("");
  const level = chainLevels[constDepth];
  const assertedAt = chainLevels[Math.max(constDepth, 1)];
  return `${outermostAssertion}${consts}${assertionAt(assertedAt)}:not(${constAt(level)})`;
}

export const chainedTypeAssertions = [0, 1, 2, 3].map((constDepth) => ({
  selector: chainSelector(constDepth),
  message: chainedMessage,
}));

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

function resolveVariable(sourceCode, identifier) {
  for (
    let scope = sourceCode.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
  }
  return null;
}

function importedName(node) {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier"
    ? node.imported.name
    : node.imported.value;
}

function isTestFrameworkObject(sourceCode, expression) {
  if (expression.type !== "Identifier") return false;
  const named = expression.name === "vi" || expression.name === "jest";
  if (named && sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) return named;
  return variable.defs.some(isTestFrameworkImport);
}

function isTestFrameworkImport(definition) {
  if (
    definition.type !== "ImportBinding" ||
    definition.parent?.type !== "ImportDeclaration"
  )
    return false;
  const source = definition.parent.source.value;
  const name = importedName(definition.node);
  return (
    (source === "vitest" && name === "vi") ||
    (source === "@jest/globals" && name === "jest")
  );
}

function moduleMockCall(sourceCode, callee) {
  if (callee.type !== "MemberExpression") return false;
  if (!isTestFrameworkObject(sourceCode, callee.object)) return false;
  const { property } = callee;
  const method = callee.computed
    ? property.type === "Literal" && moduleMockMethods.has(property.value)
      ? property.value
      : null
    : property.type === "Identifier"
      ? property.name
      : null;
  return method !== null && moduleMockMethods.has(method);
}

const noModuleMocking = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super") return;
        if (moduleMockCall(context.sourceCode, node.callee))
          context.report({ node, messageId: "moduleMock" });
      },
    };
  },
};

const arrayWrappers = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

function unwrapArrayExpression(node) {
  let current = node;
  while (arrayWrappers.has(current.type)) current = current.expression;
  return current;
}

function resolveArrayBinding(sourceCode, node) {
  const unwrapped = unwrapArrayExpression(node);
  return unwrapped.type === "Identifier"
    ? resolveVariable(sourceCode, unwrapped)
    : null;
}

function arrayMethodTarget(node) {
  const member = unwrapArrayExpression(node);
  if (member.type !== "MemberExpression") return null;
  const { property } = member;
  if (!member.computed && property.type === "Identifier")
    return { name: property.name, object: member.object };
  if (
    member.computed &&
    property.type === "Literal" &&
    typeof property.value === "string"
  )
    return { name: property.value, object: member.object };
  return null;
}

function isArrayAnnotation(type) {
  if (type.type === "TSArrayType" || type.type === "TSTupleType") return true;
  if (type.type === "TSTypeOperator" && type.operator === "readonly")
    return isArrayAnnotation(type.typeAnnotation);
  return (
    type.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    (type.typeName.name === "Array" || type.typeName.name === "ReadonlyArray")
  );
}

const knownArrayMethods = new Set([
  "map",
  "filter",
  "flatMap",
  "slice",
  "concat",
  "toSorted",
  "toReversed",
  "toSpliced",
]);

function constInitializer(variable) {
  for (const definition of variable.defs)
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator" &&
      definition.node.id.type === "Identifier" &&
      definition.node.init !== null &&
      definition.node.parent.type === "VariableDeclaration" &&
      definition.node.parent.kind === "const"
    )
      return definition.node.init;
  return null;
}

const isReassigned = (variable) =>
  variable.references.some(
    (reference) => reference.isWrite() && !reference.init,
  );

function isKnownArrayExpression(sourceCode, node, visited = new Set()) {
  const unwrapped = unwrapArrayExpression(node);
  if (unwrapped.type === "ArrayExpression") return true;
  if (unwrapped.type === "CallExpression") {
    const method = arrayMethodTarget(unwrapped.callee);
    return (
      method !== null &&
      knownArrayMethods.has(method.name) &&
      isKnownArrayExpression(sourceCode, method.object, visited)
    );
  }
  if (unwrapped.type !== "Identifier") return false;
  const variable = resolveArrayBinding(sourceCode, unwrapped);
  if (variable === null || visited.has(variable)) return false;
  visited.add(variable);
  if (isReassigned(variable)) return false;
  for (const identifier of variable.identifiers) {
    const annotation = identifier.typeAnnotation?.typeAnnotation;
    if (annotation !== undefined) return isArrayAnnotation(annotation);
  }
  const init = constInitializer(variable);
  return init !== null && isKnownArrayExpression(sourceCode, init, visited);
}

const callbackTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

function reducerOf(callback) {
  let owner = callback.parent;
  while (owner && unwrapArrayExpression(owner) === callback)
    owner = owner.parent;
  if (owner?.type !== "CallExpression") return null;
  const method = arrayMethodTarget(owner.callee);
  const [firstArgument] = owner.arguments;
  if (
    method === null ||
    (method.name !== "reduce" && method.name !== "reduceRight") ||
    owner.arguments.length > 2 ||
    firstArgument === undefined ||
    unwrapArrayExpression(firstArgument) !== callback
  )
    return null;
  const [firstParameter] = callback.params;
  const accumulator =
    firstParameter?.type === "AssignmentPattern"
      ? firstParameter.left
      : firstParameter;
  if (accumulator?.type !== "Identifier") return null;
  return { callback, accumulator, initialValue: owner.arguments[1] };
}

function enclosingReducer(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "FunctionDeclaration") return null;
    if (callbackTypes.has(parent.type)) return reducerOf(parent);
  }
  return null;
}

function referencesAccumulator(
  sourceCode,
  node,
  accumulator,
  visited = new Set(),
) {
  const variable = resolveArrayBinding(sourceCode, node);
  if (variable === null || visited.has(variable)) return false;
  if (variable === accumulator) return true;
  visited.add(variable);
  if (isReassigned(variable)) return false;
  const init = constInitializer(variable);
  return (
    init !== null &&
    referencesAccumulator(sourceCode, init, accumulator, visited)
  );
}

function isGlobalCopyOwner(sourceCode, node, name) {
  const unwrapped = unwrapArrayExpression(node);
  if (unwrapped.type !== "Identifier" || unwrapped.name !== name) return false;
  const variable = resolveArrayBinding(sourceCode, unwrapped);
  return variable === null || variable.defs.length === 0;
}

const arrayCopyMethods = new Set([
  "concat",
  "slice",
  "toSpliced",
  "toSorted",
  "toReversed",
  "with",
]);

function copiesAccumulator(sourceCode, node, method, reducer, isAccumulator) {
  if (
    method.name === "assign" &&
    isGlobalCopyOwner(sourceCode, method.object, "Object")
  ) {
    const [target] = node.arguments;
    return (
      target !== undefined &&
      unwrapArrayExpression(target).type === "ObjectExpression" &&
      node.arguments.slice(1).some(isAccumulator)
    );
  }
  if (
    method.name === "from" &&
    isGlobalCopyOwner(sourceCode, method.object, "Array")
  ) {
    const [copied] = node.arguments;
    return copied !== undefined && isAccumulator(copied);
  }
  if (!arrayCopyMethods.has(method.name)) return false;
  const { initialValue } = reducer;
  return (
    initialValue !== undefined &&
    isKnownArrayExpression(sourceCode, initialValue) &&
    isAccumulator(method.object)
  );
}

const noReduceAccumulatorCopy = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow copying growing reducer accumulators with Object.assign, Array.from, or array copy methods.",
    },
    messages: {
      accumulatorCopy:
        "Do not copy the reducer accumulator on every iteration; growing copies can cause quadratic work. Mutate a fresh, locally owned accumulator and return it, or use an iterator pipeline/flatMap.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        const method = arrayMethodTarget(node.callee);
        if (method === null) return;
        const reducer = enclosingReducer(node);
        if (reducer === null) return;
        const accumulator = sourceCode
          .getDeclaredVariables(reducer.callback)
          .find((variable) =>
            variable.identifiers.some(
              (identifier) =>
                identifier.range[0] === reducer.accumulator.range[0],
            ),
          );
        if (accumulator === undefined) return;
        const isAccumulator = (expression) =>
          referencesAccumulator(sourceCode, expression, accumulator);
        if (copiesAccumulator(sourceCode, node, method, reducer, isAccumulator))
          context.report({ node, messageId: "accumulatorCopy" });
      },
    };
  },
};

const typeScopeTypes = new Set([
  "Program",
  "BlockStatement",
  "TSModuleBlock",
  "StaticBlock",
  "SwitchStatement",
]);
const namedTypeDeclarations = new Set([
  "TSInterfaceDeclaration",
  "TSEnumDeclaration",
  "ClassDeclaration",
  "ClassExpression",
]);
const importSpecifiers = new Set([
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
]);

const isNode = (value) =>
  typeof value === "object" && value !== null && typeof value.type === "string";

function forEachChild(node, visitorKeys, visit) {
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];
    if (isNode(value)) visit(value);
    else if (Array.isArray(value))
      for (const child of value) if (isNode(child)) visit(child);
  }
}

function enclosingTypeScope(node) {
  for (let current = node.parent; current; current = current.parent)
    if (typeScopeTypes.has(current.type)) return current;
  return node;
}

function declaredTypeBinding(node) {
  if (node.type === "TSTypeAliasDeclaration")
    return { alias: node, name: node.id.name };
  if (namedTypeDeclarations.has(node.type))
    return node.id ? { alias: null, name: node.id.name } : null;
  if (importSpecifiers.has(node.type))
    return { alias: null, name: node.local.name };
  return null;
}

function collectTypeBindings(node, visitorKeys, bindingsByName) {
  const declared = declaredTypeBinding(node);
  if (declared !== null) {
    const bindings = bindingsByName.get(declared.name) ?? [];
    bindings.push({ ...declared, scope: enclosingTypeScope(node) });
    bindingsByName.set(declared.name, bindings);
  }
  forEachChild(node, visitorKeys, (child) =>
    collectTypeBindings(child, visitorKeys, bindingsByName),
  );
}

function createTypeAliasEnvironment(program, visitorKeys) {
  const bindingsByName = new Map();
  collectTypeBindings(program, visitorKeys, bindingsByName);
  return { bindingsByName, visitorKeys };
}

function collectInferTypeParameterNames(node, visitorKeys, names) {
  if (node.type === "TSInferType") names.add(node.typeParameter.name.name);
  forEachChild(node, visitorKeys, (child) =>
    collectInferTypeParameterNames(child, visitorKeys, names),
  );
}

function lexicalTypeParameterNames(node, visitorKeys) {
  const names = new Set();
  let descendant = node;
  for (
    let current = node;
    current && current.type !== "Program";
    current = current.parent
  ) {
    for (const parameter of current.typeParameters?.params ?? [])
      names.add(parameter.name.name);
    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation)
    )
      names.add(current.key.name);
    if (current.type === "TSConditionalType" && descendant === current.trueType)
      collectInferTypeParameterNames(current.extendsType, visitorKeys, names);
    descendant = current;
  }
  return names;
}

function ancestorDistance(ancestor, node) {
  let distance = 0;
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return distance;
    distance += 1;
  }
  return null;
}

function nearestTypeBindings(name, use, environment) {
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearest = [];
  for (const candidate of environment.bindingsByName.get(name) ?? []) {
    const distance = ancestorDistance(candidate.scope, use);
    if (distance === null || distance > nearestDistance) continue;
    if (distance === nearestDistance) {
      nearest.push(candidate);
      continue;
    }
    nearestDistance = distance;
    nearest = [candidate];
  }
  return nearest;
}

function visibleTypeAlias(name, use, environment) {
  if (lexicalTypeParameterNames(use, environment.visitorKeys).has(name))
    return null;
  const bindings = nearestTypeBindings(name, use, environment);
  return bindings.length === 1 ? (bindings[0].alias ?? null) : null;
}

function aliasSubstitutions(alias, reference, base, expansion) {
  const parameters = alias.typeParameters?.params ?? [];
  const typeArguments = reference.typeArguments?.params ?? [];
  const next = new Map();
  for (const [index, parameter] of parameters.entries()) {
    const explicitArgument = typeArguments[index];
    const argument = explicitArgument ?? parameter.default;
    if (argument === null || argument === undefined) return null;
    const [substitutions, resolvingAliases] =
      explicitArgument === undefined
        ? [next, expansion.innerAliases]
        : [base, expansion.resolvingAliases];
    next.set(parameter.name.name, {
      type: argument,
      substitutions: new Map(substitutions),
      resolvingAliases,
    });
  }
  return next;
}

const typeReferenceName = (type) =>
  type.typeName.type === "Identifier" ? type.typeName.name : null;

function resolvedTypeMatches(type, environment, matcher) {
  const evaluate = (current, substitutions, resolvingAliases) => {
    const name =
      current.type === "TSTypeReference" ? typeReferenceName(current) : null;
    if (name !== null) {
      const substitution = substitutions.get(name);
      if (substitution !== undefined && !current.typeArguments?.params.length)
        return evaluate(
          substitution.type,
          substitution.substitutions,
          substitution.resolvingAliases,
        );
      const alias = visibleTypeAlias(name, current, environment);
      const innerAliases = new Set([...resolvingAliases, alias]);
      const nextSubstitutions =
        alias !== null && !resolvingAliases.has(alias)
          ? aliasSubstitutions(alias, current, substitutions, {
              resolvingAliases,
              innerAliases,
            })
          : null;
      if (nextSubstitutions !== null)
        return evaluate(alias.typeAnnotation, nextSubstitutions, innerAliases);
    }
    return matcher(current, (child) =>
      evaluate(child, substitutions, resolvingAliases),
    );
  };
  return evaluate(type, new Map(), new Set());
}

const noUnknownTypeAliases = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  create(context) {
    let environment = null;
    const resolvesToUnknown = (type) =>
      environment !== null &&
      resolvedTypeMatches(
        type,
        environment,
        (resolved, matches) =>
          resolved.type === "TSUnknownKeyword" ||
          (resolved.type === "TSUnionType" && resolved.types.some(matches)),
      );
    return {
      Program(node) {
        environment = createTypeAliasEnvironment(
          node,
          context.sourceCode.visitorKeys,
        );
      },
      TSTypeAliasDeclaration(node) {
        if (!resolvesToUnknown(node.typeAnnotation)) return;
        context.report({
          node: node.id,
          messageId: "unknownAlias",
          data: { alias: node.id.name },
        });
      },
    };
  },
};

const functionBoundaryTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);
const broadKeyTypes = new Set([
  "TSStringKeyword",
  "TSNumberKeyword",
  "TSSymbolKeyword",
]);
const topTypes = new Set(["TSUnknownKeyword", "TSAnyKeyword"]);
const definitelyObjectTypes = new Set([
  "TSArrayType",
  "TSConstructorType",
  "TSFunctionType",
  "TSMappedType",
  "TSObjectKeyword",
  "TSTupleType",
]);
const knownValueTypes = new Set([
  "Literal",
  "TemplateLiteral",
  "ArrayExpression",
  "ArrowFunctionExpression",
  "ClassExpression",
  "FunctionExpression",
  "NewExpression",
  "ObjectExpression",
]);

const isUnknownOrAnyType = (type) => topTypes.has(type.type);

function isBroadRecordKeyType(type) {
  if (broadKeyTypes.has(type.type)) return true;
  if (type.type === "TSUnionType")
    return type.types.every(isBroadRecordKeyType);
  return (
    type.type === "TSTypeReference" && typeReferenceName(type) === "PropertyKey"
  );
}

function isBroadRecordReference(type) {
  const name = typeReferenceName(type);
  const parameters = type.typeArguments?.params ?? [];
  if (name === "Readonly")
    return parameters[0] !== undefined && isBroadRecordType(parameters[0]);
  return (
    name === "Record" &&
    parameters.length === 2 &&
    isBroadRecordKeyType(parameters[0]) &&
    isUnknownOrAnyType(parameters[1])
  );
}

function isBroadRecordType(type) {
  if (type.type === "TSTypeReference") return isBroadRecordReference(type);
  if (type.type !== "TSTypeLiteral" || type.members.length !== 1) return false;
  const [member] = type.members;
  const [parameter] =
    member.type === "TSIndexSignature" ? member.parameters : [];
  const keyType = parameter?.typeAnnotation?.typeAnnotation;
  const valueType = member.typeAnnotation?.typeAnnotation;
  return (
    member.type === "TSIndexSignature" &&
    member.parameters.length === 1 &&
    keyType !== undefined &&
    valueType !== undefined &&
    isBroadRecordKeyType(keyType) &&
    isUnknownOrAnyType(valueType)
  );
}

function broadTypeKind(type) {
  if (topTypes.has(type.type)) return "top";
  if (type.type === "TSObjectKeyword") return "object";
  return isBroadRecordType(type) ? "record" : null;
}

const assertionFromExpression = (expression) =>
  assertionTypes.has(expression.type) ? expression : null;

const normalizedTypeText = (sourceText, type) =>
  sourceText.slice(type.range[0], type.range[1]).replaceAll(/\s+/gu, "");

const typesHaveSameSyntax = (sourceText, left, right) =>
  left !== null &&
  normalizedTypeText(sourceText, left) ===
    normalizedTypeText(sourceText, right);

function isDefinitelyObjectType(type) {
  if (definitelyObjectTypes.has(type.type)) return true;
  if (type.type === "TSTypeLiteral") return type.members.length > 0;
  if (type.type === "TSIntersectionType")
    return type.types.every(isDefinitelyObjectType);
  return (
    type.type === "TSTypeOperator" &&
    type.operator === "readonly" &&
    isDefinitelyObjectType(type.typeAnnotation)
  );
}

function isDefinitelyNarrowerRecordType(type) {
  if (type.type === "TSTypeLiteral")
    return type.members.some((member) => member.type !== "TSIndexSignature");
  if (type.type !== "TSTypeReference") return false;
  const name = typeReferenceName(type);
  const parameters = type.typeArguments?.params ?? [];
  if (name === "Readonly")
    return (
      parameters[0] !== undefined &&
      isDefinitelyNarrowerRecordType(parameters[0])
    );
  return (
    name === "Record" &&
    parameters.length === 2 &&
    !isUnknownOrAnyType(parameters[1])
  );
}

function functionBoundary(node) {
  for (
    let current = node.parent;
    current && current.type !== "Program";
    current = current.parent
  )
    if (functionBoundaryTypes.has(current.type)) return current;
  return null;
}

function resolvedVariableForIdentifier(scopes, identifier) {
  for (const scope of scopes) {
    const reference = scope.references.find(
      (candidate) =>
        candidate.identifier.range[0] === identifier.range[0] &&
        candidate.identifier.range[1] === identifier.range[1],
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

function variableDeclarator(variable) {
  for (const definition of variable.defs)
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator"
    )
      return definition.node;
  return null;
}

function annotatedEvidence(variable, boundary) {
  const annotatedIdentifier = variable.identifiers.find(
    (identifier) =>
      identifier.typeAnnotation !== null &&
      identifier.typeAnnotation !== undefined,
  );
  const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
  if (annotation === undefined) return undefined;
  if (
    functionBoundary(annotatedIdentifier) !== boundary ||
    broadTypeKind(annotation) !== null
  )
    return null;
  return { type: annotation };
}

function isLocalConst(declarator, variable, boundary) {
  return (
    declarator !== null &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    declarator.init !== null &&
    !isReassigned(variable) &&
    functionBoundary(declarator) === boundary
  );
}

function knownValueEvidence(expression, scopes, boundary, visitedVariables) {
  if (assertionTypes.has(expression.type))
    return broadTypeKind(expression.typeAnnotation) !== null
      ? null
      : { type: expression.typeAnnotation };
  if (knownValueTypes.has(expression.type)) return { type: null };
  if (expression.type !== "Identifier") return null;
  const variable = resolvedVariableForIdentifier(scopes, expression);
  if (variable === null || visitedVariables.has(variable)) return null;
  const annotated = annotatedEvidence(variable, boundary);
  if (annotated !== undefined) return annotated;
  const declarator = variableDeclarator(variable);
  if (!isLocalConst(declarator, variable, boundary)) return null;
  return knownValueEvidence(
    declarator.init,
    scopes,
    boundary,
    new Set([...visitedVariables, variable]),
  );
}

function widenedBinding(variable, scopes) {
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    isReassigned(variable)
  )
    return null;
  const boundary = functionBoundary(declarator);
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroadKind =
    initializerAssertion === null
      ? null
      : broadTypeKind(initializerAssertion.typeAnnotation);
  const declaredBroadKind =
    declaredType === undefined ? null : broadTypeKind(declaredType);
  const broadKind = declaredBroadKind ?? initializerBroadKind;
  if (broadKind === null) return null;
  const originalExpression =
    initializerAssertion !== null && initializerBroadKind !== null
      ? initializerAssertion.expression
      : declarator.init;
  const evidence = knownValueEvidence(
    originalExpression,
    scopes,
    boundary,
    new Set([variable]),
  );
  return evidence === null
    ? null
    : { broadKind, evidence, declaredAt: declarator.range[1], boundary };
}

function assertionIsNarrower(sourceText, broadKind, evidence, assertedType) {
  if (broadTypeKind(assertedType) !== null) return false;
  if (broadKind === "top") return true;
  if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) return true;
  if (broadKind === "object") return isDefinitelyObjectType(assertedType);
  return isDefinitelyNarrowerRecordType(assertedType);
}

const noWidenThenAssert = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
    },
    messages: {
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
    },
  },
  create(context) {
    let scopes = [];
    const checkAssertion = (node) => {
      const { expression } = node;
      if (expression.type !== "Identifier") return;
      const variable = resolvedVariableForIdentifier(scopes, expression);
      if (variable === null) return;
      const widened = widenedBinding(variable, scopes);
      if (
        widened === null ||
        node.range[0] <= widened.declaredAt ||
        functionBoundary(node) !== widened.boundary ||
        !assertionIsNarrower(
          context.sourceCode.text,
          widened.broadKind,
          widened.evidence,
          node.typeAnnotation,
        )
      )
        return;
      context.report({
        node,
        messageId: "widenThenAssert",
        data: { name: expression.name },
      });
    };
    return {
      Program() {
        scopes = context.sourceCode.scopeManager.scopes;
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};

const typeWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
const loopKeywordLengths = {
  ForStatement: 3,
  ForInStatement: 3,
  ForOfStatement: 3,
  WhileStatement: 5,
  DoWhileStatement: 2,
};
const spreadKinds = { ArrayExpression: "Array", ObjectExpression: "Object" };
const reducerArities = new Set([2, 3, 4]);

function innerExpression(node) {
  let current = node;
  while (typeWrappers.has(current.type)) current = current.expression;
  return current;
}

const contains = (outer, inner) =>
  outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];

function staticPropertyName(member) {
  const { property } = member;
  if (!member.computed)
    return property.type === "Identifier" ? property.name : null;
  if (property.type === "Literal" && typeof property.value === "string")
    return property.value;
  return property.type === "TemplateLiteral" &&
    property.expressions.length === 0
    ? property.quasis[0].value.cooked
    : null;
}

function reduceMember(node) {
  if (
    node.type !== "CallExpression" ||
    node.arguments.length < 1 ||
    node.arguments.length > 2
  )
    return null;
  let callee = innerExpression(node.callee);
  if (callee.type === "ChainExpression") callee = callee.expression;
  if (callee.type !== "MemberExpression") return null;
  const name = staticPropertyName(callee);
  return name === "reduce" || name === "reduceRight" ? callee : null;
}

function referencedVariable(sourceCode, identifier) {
  for (
    let scope = sourceCode.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const reference = scope.references.find(
      (candidate) => candidate.identifier === identifier,
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

function bindingIdentifier(parameter) {
  if (parameter?.type === "Identifier") return parameter;
  return parameter?.type === "AssignmentPattern" &&
    parameter.left.type === "Identifier"
    ? parameter.left
    : null;
}

function ownParameters(callback) {
  const [first] = callback.params;
  return first?.type === "Identifier" && first.name === "this"
    ? callback.params.slice(1)
    : callback.params;
}

function nearestFunction(node) {
  for (let current = node.parent; current; current = current.parent)
    if (functionTypes.has(current.type)) return current;
  return null;
}

function enclosingReduceCall(callback) {
  for (
    let current = callback.parent;
    current && !functionTypes.has(current.type);
    current = current.parent
  ) {
    const member = reduceMember(current);
    if (member !== null) return { call: current, member };
  }
  return null;
}

function reduceSpread(definition, spread) {
  if (definition.type !== "Parameter") return null;
  const callback = definition.node;
  const parameters = ownParameters(callback);
  if (bindingIdentifier(parameters[0]) !== definition.name) return null;
  if (
    !reducerArities.has(parameters.length) ||
    nearestFunction(spread) !== callback
  )
    return null;
  const reduce = enclosingReduceCall(callback);
  if (reduce === null) return null;
  const [, initialValue] = reduce.call.arguments;
  const initial =
    initialValue === undefined ? null : innerExpression(initialValue);
  return {
    node: reduce.member.property,
    messageId: `reduce${spreadKinds[initial?.type] ?? "Unknown"}`,
  };
}

function assignmentHolding(variable, spread) {
  for (const reference of variable.references) {
    const parent = reference.identifier.parent;
    if (
      reference.isWrite() &&
      parent.type === "AssignmentExpression" &&
      parent.left === reference.identifier &&
      contains(parent.right, spread)
    )
      return parent;
  }
  return null;
}

function loopSpread(definition, variable, spread) {
  if (definition.type !== "Variable" || definition.parent.kind !== "let")
    return null;
  const assignment = assignmentHolding(variable, spread);
  if (assignment === null) return null;
  const right = innerExpression(assignment.right);
  const kind = contains(right, spread) ? spreadKinds[right.type] : undefined;
  if (kind === undefined) return null;
  for (let current = spread.parent; current; current = current.parent)
    if (
      Object.hasOwn(loopKeywordLengths, current.type) &&
      !contains(current, definition.parent)
    )
      return { loop: current, messageId: `loop${kind}` };
  return null;
}

const accumulatingNote =
  "Using spreads within accumulators leads to `O(n^2)` time complexity.";
const reduceSummary = "Do not spread accumulators in Array.prototype.reduce().";
const loopSummary = "Do not spread accumulators in loops.";

const noAccumulatingSpread = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Prevents using object or array spreads on accumulators in `Array.prototype.reduce()` and in loops.",
      url: "https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-accumulating-spread.html",
    },
    messages: {
      reduceArray: `${reduceSummary} It looks like you're spreading an \`Array\`. Consider using the \`Array.push\` or \`Array.concat\` methods to mutate the accumulator instead. ${accumulatingNote}`,
      reduceObject: `${reduceSummary} It looks like you're spreading an \`Object\`. Consider using the \`Object.assign\` or assignment operators to mutate the accumulator instead. ${accumulatingNote}`,
      reduceUnknown: `${reduceSummary} Consider using \`Object.assign()\` or \`Array.prototype.push()\` to mutate the accumulator instead. ${accumulatingNote}`,
      loopArray: `${loopSummary} Consider using \`Array.prototype.push()\` to mutate the accumulator instead. ${accumulatingNote}`,
      loopObject: `${loopSummary} Consider using \`Object.assign()\` to mutate the accumulator instead. ${accumulatingNote}`,
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      SpreadElement(spread) {
        if (spread.argument.type !== "Identifier") return;
        const variable = referencedVariable(sourceCode, spread.argument);
        const [definition] = variable?.defs ?? [];
        if (definition === undefined) return;
        const reduce = reduceSpread(definition, spread);
        if (reduce !== null) context.report(reduce);
        const looped = loopSpread(definition, variable, spread);
        if (looped === null) return;
        const start = looped.loop.range[0];
        context.report({
          loc: {
            start: sourceCode.getLocFromIndex(start),
            end: sourceCode.getLocFromIndex(
              start + loopKeywordLengths[looped.loop.type],
            ),
          },
          messageId: looped.messageId,
        });
      },
    };
  },
};

export default {
  meta: upstream,
  rules: {
    "no-widen-then-assert": noWidenThenAssert,
    "no-unknown-type-aliases": noUnknownTypeAliases,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopy,
    "no-module-mocking": noModuleMocking,
    "no-accumulating-spread": noAccumulatingSpread,
  },
};
