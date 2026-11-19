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
import type { InputFault, Slot, ValueCheck } from "./usage.ts";
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
type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly check: ValueCheck };
type IntegerValue = Extract<ValueSchema, { readonly kind: "integer" }>;
type StringValue = Extract<ValueSchema, { readonly kind: "string" }>;
const reject = (check: ValueCheck) => ({ ok: false, check }) as const;
function checkInteger(token: string, schema: IntegerValue): Checked<number> {
  if (!/^-?(0|[1-9][0-9]*)$/.test(token))
    return reject({ rule: "integer syntax" });
  const value = Number(token);
  return Number.isSafeInteger(value) &&
    value >= schema.minimum &&
    value <= schema.maximum
    ? { ok: true, value }
    : reject({
        rule: "integer bounds",
        minimum: schema.minimum,
        maximum: schema.maximum,
      });
}
async function checkString(
  token: string,
  schema: StringValue,
): Promise<Checked<string>> {
  const length = [...token].length;
  if (length < schema.minLength || length > schema.maxLength)
    return reject({
      rule: "string bounds",
      minLength: schema.minLength,
      maxLength: schema.maxLength,
    });
  if (schema.choices !== null && !schema.choices.includes(token))
    return reject({ rule: "string choices", choices: schema.choices });
  if (schema.pattern === null) return { ok: true, value: token };
  const result = await matchPattern(schema.pattern, token);
  if (result === "match") return { ok: true, value: token };
  return reject(
    result === "mismatch"
      ? { rule: "pattern mismatch", pattern: schema.pattern }
      : { rule: `pattern ${result}` },
  );
}
async function checkValue(
  token: string,
  schema: ValueSchema,
): Promise<Checked<string | number>> {
  return schema.kind === "integer"
    ? checkInteger(token, schema)
    : checkString(token, schema);
}
export async function parseValue(
  token: string,
  schema: ValueSchema,
): Promise<Validation<string | number>> {
  const checked = await checkValue(token, schema);
  return checked.ok
    ? checked
    : { ok: false, path: "input", reason: checked.check.rule };
}
function slotOf(schema: InputSchema, name: string): Slot {
  return {
    kind: schema.options.some((slot) => slot.name === name)
      ? "option"
      : "argument",
    name,
  };
}
function missingFault(
  schema: InputSchema,
  values: Record<string, unknown>,
): InputFault | undefined {
  const slot = [...schema.arguments, ...schema.options].find(
    (item) => item.required && !Object.hasOwn(values, item.name),
  );
  return slot && { kind: "missing", slot: slotOf(schema, slot.name) };
}
function constraintFault(
  schema: InputSchema,
  values: Record<string, unknown>,
): InputFault | undefined {
  const present = (name: string) => Object.hasOwn(values, name);
  for (const item of schema.constraints) {
    if (item.kind === "requires") {
      if (present(item.ifPresent) && !present(item.thenPresent))
        return {
          kind: "requires",
          slot: slotOf(schema, item.ifPresent),
          needs: slotOf(schema, item.thenPresent),
        };
      continue;
    }
    const [first, second] = item.members.filter(present);
    if (first !== undefined && second !== undefined)
      return {
        kind: "exclusive",
        slots: [slotOf(schema, first), slotOf(schema, second)],
      };
  }
  return undefined;
}
type Slots<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly fault: InputFault };
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
): Slots<{ slot: ArgumentSchema | OptionSchema; consumesValue: boolean }> {
  const option =
    !state.literal && token.startsWith("-")
      ? schema.options.find(
          (slot) => slot.name === token || slot.aliases.includes(token),
        )
      : undefined;
  if (!state.literal && token.startsWith("-") && !option)
    return { ok: false, fault: { kind: "unknown-option" } };
  const slot = option ?? schema.arguments[state.operand++];
  if (!slot) return { ok: false, fault: { kind: "extra-argument" } };
  if (
    Object.hasOwn(state.values, slot.name) &&
    !("repeatable" in slot && slot.repeatable)
  )
    return {
      ok: false,
      fault: { kind: "repeated", slot: slotOf(schema, slot.name) },
    };
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
  const previous: unknown = Object.hasOwn(state.values, slot.name)
    ? state.values[slot.name]
    : undefined;
  if (Array.isArray(previous)) previous.push(value);
  else setValue(state.values, slot.name, [value]);
}
async function parseToken(
  schema: InputSchema,
  state: ParseState,
  tokens: readonly string[],
  token: string,
): Promise<Slots<null>> {
  const selected = selectSlot(schema, state, token);
  if (!selected.ok) return selected;
  const { slot, consumesValue } = selected.value;
  const raw = consumesValue ? tokens[++state.index] : token;
  if (raw === undefined)
    return {
      ok: false,
      fault: { kind: "missing-value", slot: slotOf(schema, slot.name) },
    };
  const parsed =
    slot.value === null
      ? ({ ok: true, value: true } as const)
      : await checkValue(raw, slot.value);
  if (!parsed.ok)
    return {
      ok: false,
      fault: {
        kind: "value",
        slot: slotOf(schema, slot.name),
        check: parsed.check,
      },
    };
  saveValue(state, slot, parsed.value);
  return { ok: true, value: null };
}
const required = {
  path: "input",
  reason: "required slot or constraint",
} as const;
type Kind = InputFault["kind"];
type FaultOf<K extends Kind> = Extract<InputFault, { readonly kind: K }>;
const validations: {
  readonly [K in Kind]: (fault: FaultOf<K>) => {
    readonly path: string;
    readonly reason: string;
  };
} = {
  "unknown-option": () => ({ path: "argv", reason: "unknown option" }),
  "extra-argument": () => ({ path: "argv", reason: "additional argument" }),
  "missing-value": (fault) => ({
    path: fault.slot.name,
    reason: "missing value",
  }),
  repeated: (fault) => ({ path: fault.slot.name, reason: "repeated slot" }),
  value: (fault) => ({ path: "input", reason: fault.check.rule }),
  missing: () => required,
  requires: () => required,
  exclusive: () => required,
  invalid: () => required,
};
function validationOf<K extends Kind>(fault: FaultOf<K>) {
  return validations[fault.kind](fault);
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
  const parsed = await parseSlots(schema, tokens);
  if (!parsed.ok) return { ok: false, ...validationOf(parsed.fault) };
  return deadlineMilliseconds !== undefined
    ? { ...parsed, deadlineMilliseconds }
    : parsed;
}

export async function parseSlots<I extends InputSchema>(
  schema: I,
  tokens: readonly string[],
): Promise<
  | { readonly ok: true; readonly value: ParsedInput<I> }
  | { readonly ok: false; readonly fault: InputFault }
> {
  const state: ParseState = {
    index: 0,
    operand: 0,
    literal: false,
    values: {},
  };
  for (; state.index < tokens.length; state.index++) {
    const token = tokens[state.index];
    if (token === undefined) return { ok: false, fault: { kind: "invalid" } };
    if (!state.literal && token === "--") {
      state.literal = true;
      continue;
    }
    const parsed = await parseToken(schema, state, tokens, token);
    if (!parsed.ok) return parsed;
  }
  const broken = constraintFault(schema, state.values);
  if (parsedInput(state.values, schema) && !broken)
    return { ok: true, value: state.values };
  return {
    ok: false,
    fault: missingFault(schema, state.values) ?? broken ?? { kind: "invalid" },
  };
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
  input: ParsedInput<InputSchema>,
): boolean {
  return route.length > 0 || Object.keys(input).length > 0;
}
