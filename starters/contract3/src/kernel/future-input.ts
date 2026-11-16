import {
  deadlineOption,
  splitDeadlineTokens,
  parseDeadlineValue,
} from "./deadline.ts";
import type { CommandDeclaration } from "./declarations.ts";
import type { ValueSchema } from "./input-types.ts";
import type { Validation } from "./types.ts";
import { parseValue } from "./input.ts";
import { safeRunValue, guidanceTargets, bindingNames } from "./guidance.ts";
const inputTableKey = Symbol("kernel.inputRegistration");
export type InputTable = { readonly [inputTableKey]: true };
const contexts = new WeakMap<object, readonly CommandDeclaration[]>();
export function buildInputTable(
  commands: readonly CommandDeclaration[],
): InputTable {
  const registration = Object.freeze({ [inputTableKey]: true as const });
  contexts.set(registration, commands);
  return registration;
}

function targetSlots(
  source: CommandDeclaration,
  command: CommandDeclaration,
  templates: readonly string[],
): Validation<
  readonly { readonly template: string; readonly value: ValueSchema }[]
> {
  const deadline = splitDeadlineTokens(templates);
  if (!deadline.ok) return deadline;
  if (
    deadline.value.deadlineValue !== undefined &&
    !command.input.deadlineSupported
  )
    return {
      ok: false,
      path: deadlineOption.name,
      reason: "command does not support deadlines",
    };
  const value = deadline.value.deadlineValue;
  if (value !== undefined && !runtimeDeadlineBinding(source, value)) {
    const parsed = parseDeadlineValue(value);
    if (!parsed.ok) return parsed;
  }
  return { ok: true, value: domainTargetSlots(command, deadline.value.tokens) };
}
function runtimeDeadlineBinding(
  command: CommandDeclaration,
  value: string,
): boolean {
  return command.stations
    .flatMap(bindingNames)
    .some(
      (name) =>
        value === `{binding.${name}}` &&
        !Object.hasOwn(command.futureBindings ?? {}, name),
    );
}
function domainTargetSlots(
  command: CommandDeclaration,
  args: readonly string[],
): readonly { readonly template: string; readonly value: ValueSchema }[] {
  const result: { template: string; value: ValueSchema }[] = [];
  let operand = 0;
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) continue;
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    const option = !literal
      ? command.input.options.find(
          (entry) => entry.name === token || entry.aliases.includes(token),
        )
      : undefined;
    const slot = option ?? command.input.arguments[operand++];
    if (!slot?.value) continue;
    const template = option ? args[++index] : token;
    if (template !== undefined) result.push({ template, value: slot.value });
  }
  return result;
}
function deadlineArguments(
  command: CommandDeclaration,
  args: readonly string[],
  values: Readonly<Record<string, unknown>>,
): readonly string[] {
  let literal = false;
  return args.map((argument, index) => {
    if (argument === "--") literal = true;
    if (literal || args[index - 1] !== deadlineOption.name) return argument;
    return callerBinding(command, argument, values);
  });
}
function callerBinding(
  command: CommandDeclaration,
  argument: string,
  values: Readonly<Record<string, unknown>>,
): string {
  for (const [binding, source] of Object.entries(
    command.futureBindings ?? {},
  )) {
    const token =
      binding === "idempotencyKey"
        ? "{idempotencyKey}"
        : `{binding.${binding}}`;
    const value = Object.hasOwn(values, source) ? values[source] : undefined;
    if (argument === token && typeof value === "string") return value;
  }
  return argument;
}
export async function validateFutureInputs(
  command: CommandDeclaration,
  values: Readonly<Record<string, unknown>>,
  registration: InputTable | undefined,
): Promise<Validation<null>> {
  const mapping = command.futureBindings ?? {};
  if (Object.keys(mapping).length === 0) return { ok: true, value: null };
  const commands = registration ? contexts.get(registration) : undefined;
  if (!commands?.includes(command))
    return {
      ok: false,
      path: "bindings",
      reason: "command is not declared in this contract",
    };
  const routes = commands.flatMap((entry) => entry.route);
  for (const [binding, source] of Object.entries(mapping)) {
    const value = Object.hasOwn(values, source) ? values[source] : undefined;
    if (value === undefined) continue;
    if (typeof value !== "string" || !safeRunValue(value, routes, true))
      return { ok: false, path: source, reason: "invalid future binding" };
    const checked = await validateTargetValue(
      command,
      commands,
      binding,
      value,
      values,
    );
    if (!checked.ok) return { ...checked, path: source };
  }
  return { ok: true, value: null };
}

async function validateTargetValue(
  command: CommandDeclaration,
  commands: readonly CommandDeclaration[],
  binding: string,
  value: string,
  values: Readonly<Record<string, unknown>>,
): Promise<Validation<null>> {
  const token =
    binding === "idempotencyKey" ? "{idempotencyKey}" : `{binding.${binding}}`;
  for (const { target, args } of guidanceTargets(command, commands)) {
    if (!target)
      return { ok: false, path: binding, reason: "undeclared binding target" };
    const slots = targetSlots(
      command,
      target,
      deadlineArguments(command, args, values),
    );
    if (!slots.ok) return slots;
    for (const slot of slots.value) {
      if (!slot.template.includes(token)) continue;
      const parsed = await parseValue(
        slot.template.replaceAll(token, value),
        slot.value,
      );
      if (!parsed.ok) return parsed;
    }
  }
  return { ok: true, value: null };
}
