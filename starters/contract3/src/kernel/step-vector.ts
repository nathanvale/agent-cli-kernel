import { parseDeadlineValue, splitDeadlineTokens } from "./deadline.ts";
import type { CommandDeclaration } from "./declarations.ts";
import type {
  ArgumentSchema,
  InputSchema,
  OptionSchema,
  ValueSchema,
} from "./input-types.ts";

// F01, decided option 2: a command-step template is refused at admission when
// no single-token value for its templated elements can make the vector parse
// (STEP-6 applied at declaration). Each substitution fills one whole element,
// never empty and never starting with "-" (STEP-9a, STEP-10), so the element
// count, option tokens and slot occurrence are fixed by the template. Values
// of templated elements stay value-dependent and are checked at emission, as
// are literal values aimed at a pattern slot (pattern matching is
// asynchronous and admission is not). A templated element whose literal text
// begins with "-" is an option token whose name no declared option has.
const templated = (element: string) => /\{[^{}]*\}/.test(element);

function literalValue(token: string, schema: ValueSchema): boolean {
  if (templated(token)) return true;
  if (schema.kind === "integer") {
    const value = Number(token);
    return (
      /^-?(0|[1-9][0-9]*)$/.test(token) &&
      Number.isSafeInteger(value) &&
      value >= schema.minimum &&
      value <= schema.maximum
    );
  }
  const length = [...token].length;
  return (
    length >= schema.minLength &&
    length <= schema.maxLength &&
    (schema.choices === null || schema.choices.includes(token))
  );
}
function deadlineProblem(
  input: InputSchema,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!input.deadlineSupported) return "the target does not accept a deadline";
  return templated(value) || parseDeadlineValue(value).ok
    ? undefined
    : "its literal deadline is not a positive integer";
}
type Occurrence = { operand: number; readonly present: Set<string> };
function slotFor(
  input: InputSchema,
  token: string,
  literal: boolean,
  state: Occurrence,
): ArgumentSchema | OptionSchema | string {
  if (!literal && token.startsWith("-")) {
    const option = input.options.find(
      (slot) => slot.name === token || slot.aliases.includes(token),
    );
    if (!option) return `${token} is not an option of the target`;
    if (state.present.has(option.name) && !option.repeatable)
      return `${option.name} repeats`;
    return option;
  }
  const argument = input.arguments[state.operand++];
  return argument ?? "it has an additional operand";
}
function occurrences(
  input: InputSchema,
  tokens: readonly string[],
): Set<string> | string {
  const state: Occurrence = { operand: 0, present: new Set<string>() };
  let literal = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    const slot = slotFor(input, token, literal, state);
    if (typeof slot === "string") return slot;
    state.present.add(slot.name);
    if (slot.value === null) continue;
    const raw = "aliases" in slot ? tokens[++index] : token;
    if (raw === undefined) return `${slot.name} has no value`;
    if (!literalValue(raw, slot.value))
      return `its literal value for ${slot.name} is invalid`;
  }
  return state.present;
}
function presenceProblem(
  target: CommandDeclaration,
  present: ReadonlySet<string>,
): string | undefined {
  const input = target.input;
  const missing = [...input.arguments, ...input.options].find(
    (slot) => slot.required && !present.has(slot.name),
  );
  if (missing) return `required ${missing.name} is absent`;
  const broken = input.constraints.find((item) =>
    item.kind === "requires"
      ? present.has(item.ifPresent) && !present.has(item.thenPresent)
      : item.members.filter((name) => present.has(name)).length > 1,
  );
  if (broken) return "it breaks an input constraint";
  return target.route.length === 0 && present.size === 0
    ? "a root operation needs an option or operand"
    : undefined;
}
export function stepVectorProblem(
  target: CommandDeclaration,
  args: readonly string[],
): string | undefined {
  const split = splitDeadlineTokens(args);
  if (!split.ok) return "its deadline option has no single value";
  const deadline = deadlineProblem(target.input, split.value.deadlineValue);
  if (deadline) return deadline;
  const present = occurrences(target.input, split.value.tokens);
  return typeof present === "string"
    ? present
    : presenceProblem(target, present);
}
