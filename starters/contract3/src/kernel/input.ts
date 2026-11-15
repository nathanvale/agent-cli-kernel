import { splitDeadline } from "./deadline.ts";
import type { DeadlineValidation } from "./deadline.ts";
import type {
  ArgumentSchema,
  InputSchema,
  OptionSchema,
  ParsedInput,
  ValueSchema,
} from "./input-types.ts";
import type { Validation } from "./types.ts";
import { parsedInput } from "./validation/input.ts";
export const emptyInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const satisfies InputSchema;
export type PatternResult = "match" | "mismatch" | "invalid" | "budget";
export async function matchPattern(
  pattern: string,
  input: string | null,
): Promise<PatternResult> {
  if (pattern.length > 1024 || (input !== null && [...input].length > 4096))
    return "budget";
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL("./pattern-worker.ts", import.meta.url).href,
    );
    const finish = (result: PatternResult) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish("budget"), 250);
    worker.onmessage = (event: MessageEvent<unknown>) =>
      finish(
        event.data === "match"
          ? "match"
          : event.data === "mismatch"
            ? "mismatch"
            : "invalid",
      );
    worker.onerror = () => finish("invalid");
    worker.postMessage({ pattern, input });
  });
}
export async function parseValue(
  token: string,
  schema: ValueSchema,
): Promise<Validation<string | number>> {
  const reject = (reason: string): Validation<never> => ({
    ok: false,
    path: "input",
    reason,
  });
  if (schema.kind === "integer") {
    if (!/^-?(0|[1-9][0-9]*)$/.test(token)) return reject("integer syntax");
    const value = Number(token);
    return Number.isSafeInteger(value) &&
      value >= schema.minimum &&
      value <= schema.maximum
      ? { ok: true, value }
      : reject("integer bounds");
  }
  const length = [...token].length;
  if (length < schema.minLength || length > schema.maxLength)
    return reject("string bounds");
  if (schema.choices !== null && !schema.choices.includes(token))
    return reject("string choices");
  if (schema.pattern !== null) {
    const result = await matchPattern(schema.pattern, token);
    if (result !== "match") return reject(`pattern ${result}`);
  }
  return { ok: true, value: token };
}
function constraintsHold(
  schema: InputSchema,
  values: Record<string, unknown>,
): boolean {
  return schema.constraints.every((item) =>
    item.kind === "requires"
      ? !Object.hasOwn(values, item.ifPresent) ||
        Object.hasOwn(values, item.thenPresent)
      : item.members.filter((name) => Object.hasOwn(values, name)).length <= 1,
  );
}
type ParseState = {
  index: number;
  operand: number;
  literal: boolean;
  values: Record<string, unknown>;
};
function selectSlot(
  schema: InputSchema,
  state: ParseState,
  token: string,
): Validation<{ slot: ArgumentSchema | OptionSchema; consumesValue: boolean }> {
  const option =
    !state.literal && token.startsWith("-")
      ? schema.options.find(
          (slot) => slot.name === token || slot.aliases.includes(token),
        )
      : undefined;
  if (!state.literal && token.startsWith("-") && !option)
    return { ok: false, path: "argv", reason: "unknown option" };
  const slot = option ?? schema.arguments[state.operand++];
  if (!slot) return { ok: false, path: "argv", reason: "additional argument" };
  if (
    Object.hasOwn(state.values, slot.name) &&
    !("repeatable" in slot && slot.repeatable)
  )
    return { ok: false, path: slot.name, reason: "repeated slot" };
  return {
    ok: true,
    value: { slot, consumesValue: option !== undefined && slot.value !== null },
  };
}
function saveValue(
  state: ParseState,
  slot: ArgumentSchema | OptionSchema,
  value: string | number | boolean,
): void {
  if (!("repeatable" in slot && slot.repeatable)) {
    setValue(state.values, slot.name, value);
    return;
  }
  // Append in place to this parse's own array: linear, ordered, never shared
  // across parses (R1).
  const previous: unknown = Object.hasOwn(state.values, slot.name)
    ? state.values[slot.name]
    : undefined;
  if (Array.isArray(previous)) previous.push(value);
  else setValue(state.values, slot.name, [value]);
}
async function parseToken(
  schema: InputSchema,
  state: ParseState,
  argv: readonly unknown[],
  token: string,
): Promise<Validation<null>> {
  const selected = selectSlot(schema, state, token);
  if (!selected.ok) return selected;
  const { slot, consumesValue } = selected.value;
  const raw: unknown = consumesValue ? argv[++state.index] : token;
  if (typeof raw !== "string")
    return { ok: false, path: slot.name, reason: "missing value" };
  const parsed =
    slot.value === null
      ? ({ ok: true, value: true } as const)
      : await parseValue(raw, slot.value);
  if (!parsed.ok) return parsed;
  saveValue(state, slot, parsed.value);
  return { ok: true, value: null };
}
export async function parseInput<I extends InputSchema>(
  schema: I,
  argv: unknown,
): Promise<DeadlineValidation<ParsedInput<I>>> {
  if (
    !Array.isArray(argv) ||
    !argv.every((token: unknown) => typeof token === "string")
  )
    return { ok: false, path: "argv", reason: "expected string tokens" };
  const deadline = splitDeadline(argv);
  if (!deadline.ok) return deadline;
  const { tokens, deadlineMilliseconds } = deadline.value;
  if (deadlineMilliseconds !== undefined && !schema.deadlineSupported)
    return {
      ok: false,
      path: "--deadline-ms",
      reason: "command does not support deadlines",
    };
  const parsed = await parseDomainInput(schema, tokens);
  return parsed.ok
    ? {
        ...parsed,
        ...(deadlineMilliseconds === undefined ? {} : { deadlineMilliseconds }),
      }
    : parsed;
}

async function parseDomainInput<I extends InputSchema>(
  schema: I,
  tokens: readonly string[],
): Promise<Validation<ParsedInput<I>>> {
  const state: ParseState = {
    index: 0,
    operand: 0,
    literal: false,
    values: {},
  };
  for (; state.index < tokens.length; state.index++) {
    const token: unknown = tokens[state.index];
    if (typeof token !== "string")
      return { ok: false, path: "argv", reason: "expected string" };
    if (!state.literal && token === "--") {
      state.literal = true;
      continue;
    }
    const parsed = await parseToken(schema, state, tokens, token);
    if (!parsed.ok) return parsed;
  }
  return parsedInput(state.values, schema) &&
    constraintsHold(schema, state.values)
    ? { ok: true, value: state.values }
    : { ok: false, path: "input", reason: "required slot or constraint" };
}

function setValue(
  values: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  Object.defineProperty(values, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function acceptsRootInput(
  route: readonly string[],
  input: object,
): boolean {
  return route.length > 0 || Object.keys(input).length > 0;
}
