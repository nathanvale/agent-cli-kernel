import type {
  ArgumentSchema,
  Constraint,
  InputSchema,
  OptionSchema,
  ParsedInput,
  ValueSchema,
} from "../input-types.ts";
import { integer, json, keys, record, text } from "./primitives.ts";
const reserved = [
  "--json",
  "--help",
  "--discover",
  "--discover-all",
  "--discover-command",
  "--deadline-ms",
];
export function valueSchema(value: unknown): value is ValueSchema {
  if (!record(value)) return false;
  if (value.kind === "integer")
    return (
      keys(value, ["kind", "minimum", "maximum"]) &&
      Number.isSafeInteger(value.minimum) &&
      Number.isSafeInteger(value.maximum) &&
      typeof value.minimum === "number" &&
      typeof value.maximum === "number" &&
      value.maximum >= value.minimum
    );
  if (
    value.kind !== "string" ||
    !keys(value, ["kind", "minLength", "maxLength", "choices", "pattern"])
  )
    return false;
  if (
    !integer(value.minLength) ||
    !integer(value.maxLength) ||
    value.maxLength < value.minLength
  )
    return false;
  if (
    value.pattern !== null &&
    (typeof value.pattern !== "string" ||
      value.pattern.length > 1024 ||
      value.maxLength > 4096)
  )
    return false;
  return validChoices({
    ...value,
    minLength: value.minLength,
    maxLength: value.maxLength,
  });
}
function validChoices(
  value: Record<string, unknown> & { minLength: number; maxLength: number },
): boolean {
  if (value.choices === null) return true;
  const min = value.minLength,
    max = value.maxLength;
  return (
    Array.isArray(value.choices) &&
    value.choices.length > 0 &&
    new Set(value.choices).size === value.choices.length &&
    value.choices.every(
      (choice: unknown) =>
        typeof choice === "string" &&
        [...choice].length >= min &&
        [...choice].length <= max,
    )
  );
}
function argument(value: unknown): value is ArgumentSchema {
  return (
    record(value) &&
    keys(value, ["name", "summary", "required", "value"]) &&
    text(value.name) &&
    text(value.summary) &&
    typeof value.required === "boolean" &&
    valueSchema(value.value)
  );
}
function option(value: unknown): value is OptionSchema {
  if (
    !record(value) ||
    !keys(value, [
      "name",
      "aliases",
      "summary",
      "required",
      "repeatable",
      "value",
    ])
  )
    return false;
  return (
    typeof value.name === "string" &&
    /^--[a-z][a-z0-9-]*$/.test(value.name) &&
    Array.isArray(value.aliases) &&
    value.aliases.every(
      (alias: unknown) =>
        typeof alias === "string" &&
        /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(alias),
    ) &&
    text(value.summary) &&
    typeof value.required === "boolean" &&
    typeof value.repeatable === "boolean" &&
    (value.value === null
      ? value.repeatable === false
      : valueSchema(value.value))
  );
}
function constraint(value: unknown): value is Constraint {
  if (!record(value)) return false;
  if (value.kind === "requires")
    return (
      keys(value, ["kind", "ifPresent", "thenPresent"]) &&
      text(value.ifPresent) &&
      text(value.thenPresent)
    );
  return (
    value.kind === "exclusive" &&
    keys(value, ["kind", "members"]) &&
    Array.isArray(value.members) &&
    value.members.length >= 2 &&
    value.members.every(text) &&
    new Set(value.members).size === value.members.length
  );
}
function schemaShape(value: unknown): value is InputSchema {
  return (
    record(value) &&
    keys(value, [
      "arguments",
      "options",
      "constraints",
      "deadlineSupported",
      "additionalArguments",
      "additionalOptions",
    ]) &&
    Array.isArray(value.arguments) &&
    value.arguments.every(argument) &&
    Array.isArray(value.options) &&
    value.options.every(option) &&
    Array.isArray(value.constraints) &&
    value.constraints.every(constraint) &&
    typeof value.deadlineSupported === "boolean" &&
    value.additionalArguments === false &&
    value.additionalOptions === false
  );
}
function constraintsPossible(schema: InputSchema, names: Set<string>): boolean {
  const required = new Set(
    [...schema.arguments, ...schema.options].flatMap((slot) =>
      slot.required ? [slot.name] : [],
    ),
  );
  for (let pass = 0; pass <= names.size; pass++)
    for (const item of schema.constraints)
      if (item.kind === "requires" && required.has(item.ifPresent))
        required.add(item.thenPresent);
  return schema.constraints.every((item) =>
    item.kind === "requires"
      ? names.has(item.ifPresent) && names.has(item.thenPresent)
      : item.members.every((name) => names.has(name)) &&
        item.members.filter((name) => required.has(name)).length <= 1,
  );
}
export function inputSchema(value: unknown): value is InputSchema {
  if (!json(value) || !schemaShape(value)) return false;
  const names = [...value.arguments, ...value.options].map((slot) => slot.name);
  const options = value.options.flatMap((slot) => [slot.name, ...slot.aliases]);
  if (
    new Set(names).size !== names.length ||
    new Set(options).size !== options.length ||
    options.some((name) => reserved.includes(name))
  )
    return false;
  let optional = false;
  for (const arg of value.arguments) {
    if (!arg.required) optional = true;
    else if (optional) return false;
  }
  return constraintsPossible(value, new Set(names));
}
export function parsedInput<I extends InputSchema>(
  value: Record<string, unknown>,
  schema: I,
): value is Record<string, unknown> & ParsedInput<I> {
  const slots = [...schema.arguments, ...schema.options];
  if (
    Object.keys(value).some((name) => !slots.some((slot) => slot.name === name))
  )
    return false;
  return slots.every((slot) => {
    const item = Object.hasOwn(value, slot.name) ? value[slot.name] : undefined;
    if (item === undefined) return !slot.required;
    const scalar = (entry: unknown) =>
      slot.value === null
        ? typeof entry === "boolean"
        : slot.value.kind === "integer"
          ? typeof entry === "number" && Number.isSafeInteger(entry)
          : typeof entry === "string";
    return "repeatable" in slot && slot.repeatable
      ? Array.isArray(item) && item.every(scalar)
      : scalar(item);
  });
}
