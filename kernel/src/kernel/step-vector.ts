import { parseDeadlineValue, splitDeadlineTokens } from "./deadline.ts";
import type { CommandDeclaration } from "./declarations.ts";
import { splitLongOption } from "./input.ts";
import type {
  ArgumentSchema,
  InputSchema,
  OptionSchema,
  ValueSchema,
} from "./input-types.ts";

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
type SelectedStepSlot = {
  readonly slot: ArgumentSchema | OptionSchema;
  readonly inlineValue?: string;
};
function optionSlotFor(
  input: InputSchema,
  token: string,
  state: Occurrence,
): SelectedStepSlot | string {
  const split = splitLongOption(token);
  const option = input.options.find(
    (slot) => slot.name === split.name || slot.aliases.includes(split.name),
  );
  if (!option)
    return templated(split.name)
      ? `a run value in ${split.name} would select an option the step does not name`
      : `${split.name} is not an option of the target`;
  if (option.value === null && split.value !== undefined)
    return `${option.name} takes no value`;
  if (state.present.has(option.name) && !option.repeatable)
    return `${option.name} repeats`;
  return split.value === undefined
    ? { slot: option }
    : { slot: option, inlineValue: split.value };
}
function slotFor(
  input: InputSchema,
  token: string,
  literal: boolean,
  state: Occurrence,
): SelectedStepSlot | string {
  if (!literal && token.startsWith("-"))
    return optionSlotFor(input, token, state);
  const argument = input.arguments[state.operand++];
  return argument ? { slot: argument } : "it has an additional operand";
}
function checkSelectedValue(
  selected: SelectedStepSlot,
  token: string,
  tokens: readonly string[],
  index: number,
): { readonly nextIndex: number; readonly error?: string } {
  const { slot, inlineValue } = selected;
  if (slot.value === null) return { nextIndex: index };
  const takesNext = inlineValue === undefined && "aliases" in slot;
  const raw = inlineValue ?? (takesNext ? tokens[index + 1] : token);
  const nextIndex = takesNext ? index + 1 : index;
  if (raw === undefined)
    return { nextIndex, error: `${slot.name} has no value` };
  return literalValue(raw, slot.value)
    ? { nextIndex }
    : { nextIndex, error: `its literal value for ${slot.name} is invalid` };
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
    const selected = slotFor(input, token, literal, state);
    if (typeof selected === "string") return selected;
    state.present.add(selected.slot.name);
    const checked = checkSelectedValue(selected, token, tokens, index);
    if (checked.error !== undefined) return checked.error;
    index = checked.nextIndex;
  }
  return state.present;
}
function presenceProblem(
  target: CommandDeclaration,
  present: ReadonlySet<string>,
  rootRule: boolean,
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
  return rootRule && target.route.length === 0 && present.size === 0
    ? "a root operation needs an option or operand"
    : undefined;
}
export function stepVectorProblem(
  target: CommandDeclaration,
  args: readonly string[],
  rootRule: boolean,
): string | undefined {
  const split = splitDeadlineTokens(args);
  if (!split.ok) return "its deadline option has no single value";
  const deadline = deadlineProblem(target.input, split.value.deadlineValue);
  if (deadline) return deadline;
  const present = occurrences(target.input, split.value.tokens);
  return typeof present === "string"
    ? present
    : presenceProblem(target, present, rootRule);
}
