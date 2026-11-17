import ts from "typescript";

const prototypeOwners = new Set([
  "Object",
  "Function",
  "CallableFunction",
  "NewableFunction",
]);

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

export default {
  rules: {
    "no-in-operator": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          in: "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString, so a payload passes a check for a key it never had; check own data and read it into a place typed unknown. Repair: (Object.hasOwn({{target}}, {{key}}) ? Reflect.get({{target}}, {{key}}) : undefined)",
          inBound:
            "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString; a second evaluation of {{target}} or {{key}} may yield another value, so bind both once, in the order {{how}} evaluates them, then read the own value into a place typed unknown. Repair: {{bindings}} const own: unknown = Object.hasOwn(target, key) ? Reflect.get(target, key) : undefined;",
          forIn:
            "for...in also walks inherited enumerable keys. Repair: for (const key of Object.keys({{target}}))",
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
  },
};
