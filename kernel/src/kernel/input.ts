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
const patternWorkerSource = `self.onmessage = (event) => {
  const value = event.data;
  const fields = typeof value === "object" && value !== null ? value : {};
  const hasPattern = Object.hasOwn(fields, "pattern");
  const hasInput = Object.hasOwn(fields, "input");
  const pattern = hasPattern ? fields.pattern : undefined;
  const input = hasInput ? fields.input : undefined;
  if (
    !hasPattern ||
    !hasInput ||
    typeof pattern !== "string" ||
    (input !== null && typeof input !== "string")
  ) {
    self.postMessage("invalid");
    return;
  }
  try {
    const expression = new RegExp("^(?:" + pattern + ")$", "u");
    self.postMessage(
      input === null || expression.test(input) ? "match" : "mismatch",
    );
  } catch {
    self.postMessage("invalid");
  }
};`;
const patternWorker: { address?: string } = {};
function patternWorkerAddress(): string {
  patternWorker.address ??= URL.createObjectURL(
    new Blob([patternWorkerSource], { type: "text/javascript" }),
  );
  return patternWorker.address;
}
export async function matchPattern(
  pattern: string,
  input: string | null,
): Promise<PatternResult> {
  if (pattern.length > 1024 || (input !== null && [...input].length > 4096))
    return "budget";
  return new Promise((resolve) => {
    const worker = new Worker(patternWorkerAddress());
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
const nearest = 2;
const bare = (name: string) => name.replace(/^-+/, "");
function swapped(a: string, b: string, i: number, j: number): boolean {
  return i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
}
function distance(a: string, b: string): number {
  const width = b.length + 1;
  const grid: number[] = [];
  const at = (i: number, j: number) => grid[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i++)
    for (let j = 0; j <= b.length; j++)
      grid.push(
        i === 0 || j === 0
          ? i + j
          : Math.min(
              at(i - 1, j) + 1,
              at(i, j - 1) + 1,
              at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1),
              swapped(a, b, i, j) ? at(i - 2, j - 2) + 1 : Infinity,
            ),
      );
  return at(a.length, b.length);
}
function closestOption(schema: InputSchema, token: string): Slot | null {
  const typed = bare(token);
  let closest: Slot | null = null;
  let best = nearest + 1;
  for (const option of schema.options)
    for (const name of [option.name, ...option.aliases].map(bare)) {
      if (Math.abs(name.length - typed.length) > nearest) continue;
      const found = distance(typed, name);
      if (found < best && found * 2 < name.length) {
        closest = { kind: "option", name: option.name };
        best = found;
      }
    }
  return closest;
}
export type SplitOption = {
  readonly name: string;
  readonly value?: string;
};
export function splitLongOption(token: string): SplitOption {
  const equals = token.startsWith("--") ? token.indexOf("=") : -1;
  return equals < 0
    ? { name: token }
    : { name: token.slice(0, equals), value: token.slice(equals + 1) };
}
function optionNameOnly(token: string): string {
  const equals = token.indexOf("=");
  return equals < 0 ? token : token.slice(0, equals);
}
type SelectedSlot = {
  readonly slot: ArgumentSchema | OptionSchema;
  readonly consumesValue: boolean;
  readonly inlineValue?: string;
};
function selectOption(
  schema: InputSchema,
  state: ParseState,
  token: string,
): Slots<SelectedSlot> {
  const split = splitLongOption(token);
  const option = schema.options.find(
    (slot) => slot.name === split.name || slot.aliases.includes(split.name),
  );
  if (!option) {
    const name = optionNameOnly(token);
    return {
      ok: false,
      fault: {
        kind: "unknown-option",
        option: name,
        closest: closestOption(schema, name),
      },
    };
  }
  if (option.value === null && split.value !== undefined)
    return {
      ok: false,
      fault: { kind: "unexpected-value", slot: slotOf(schema, option.name) },
    };
  if (Object.hasOwn(state.values, option.name) && !option.repeatable)
    return {
      ok: false,
      fault: { kind: "repeated", slot: slotOf(schema, option.name) },
    };
  return {
    ok: true,
    value: {
      slot: option,
      consumesValue: option.value !== null && split.value === undefined,
      ...(split.value === undefined ? {} : { inlineValue: split.value }),
    },
  };
}
function selectSlot(
  schema: InputSchema,
  state: ParseState,
  token: string,
): Slots<SelectedSlot> {
  if (!state.literal && token.startsWith("-"))
    return selectOption(schema, state, token);
  const slot = schema.arguments[state.operand++];
  if (!slot) return { ok: false, fault: { kind: "extra-argument" } };
  return { ok: true, value: { slot, consumesValue: false } };
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
  const { slot, consumesValue, inlineValue } = selected.value;
  const raw =
    inlineValue !== undefined
      ? inlineValue
      : consumesValue
        ? tokens[++state.index]
        : token;
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
  "unexpected-value": (fault) => ({
    path: fault.slot.name,
    reason: "unexpected value",
  }),
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
