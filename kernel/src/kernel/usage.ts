import type { commonCauses } from "./causes.ts";

export type Slot = {
  readonly kind: "argument" | "option";
  readonly name: string;
};
export type ValueCheck =
  | { readonly rule: "integer syntax" }
  | {
      readonly rule: "integer bounds";
      readonly minimum: number;
      readonly maximum: number;
    }
  | {
      readonly rule: "string bounds";
      readonly minLength: number;
      readonly maxLength: number;
    }
  | { readonly rule: "string choices"; readonly choices: readonly string[] }
  | { readonly rule: "pattern mismatch"; readonly pattern: string }
  | { readonly rule: "pattern invalid" }
  | { readonly rule: "pattern budget" };
export type InputFault =
  | {
      readonly kind: "unknown-option";
      readonly option: string;
      readonly closest: Slot | null;
    }
  | { readonly kind: "unexpected-value"; readonly slot: Slot }
  | { readonly kind: "extra-argument" }
  | { readonly kind: "missing-value"; readonly slot: Slot }
  | { readonly kind: "repeated"; readonly slot: Slot }
  | { readonly kind: "missing"; readonly slot: Slot }
  | { readonly kind: "value"; readonly slot: Slot; readonly check: ValueCheck }
  | { readonly kind: "requires"; readonly slot: Slot; readonly needs: Slot }
  | { readonly kind: "exclusive"; readonly slots: readonly [Slot, Slot] }
  | { readonly kind: "invalid" };
export type UsageFault =
  | InputFault
  | { readonly kind: "no-command" }
  | { readonly kind: "navigation-conflict" }
  | { readonly kind: "navigation-shape" }
  | { readonly kind: "deadline" }
  | { readonly kind: "deadline-unsupported" }
  | { readonly kind: "root-input" }
  | { readonly kind: "later-step" }
  | { readonly kind: "unknown-command" };
type Kind = UsageFault["kind"];
type FaultOf<K extends Kind> = Extract<UsageFault, { readonly kind: K }>;
type Rule = ValueCheck["rule"];
type CheckOf<R extends Rule> = Extract<ValueCheck, { readonly rule: R }>;

const label = (slot: Slot) => `${slot.kind} ${slot.name}`;
const maxOptionDisplayLength = 64;
function unknownOptionSubject(option: string): string {
  return option.length > 0 &&
    option.length <= maxOptionDisplayLength &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/u.test(option)
    ? `${option}, an option`
    : "an option";
}

const checkWords: {
  readonly [R in Rule]: (check: CheckOf<R>, slot: string) => string;
} = {
  "integer syntax": (_check, slot) => `The ${slot} must be a whole number.`,
  "integer bounds": (check, slot) =>
    `The ${slot} must be a whole number from ${check.minimum} to ${check.maximum}.`,
  "string bounds": (check, slot) =>
    `The ${slot} must be ${check.minLength} to ${check.maxLength} characters long.`,
  "string choices": (check, slot) =>
    `The ${slot} must be one of: ${check.choices.join(", ")}.`,
  "pattern mismatch": (check, slot) =>
    `The ${slot} must match the pattern ${check.pattern}.`,
  "pattern invalid": (_check, slot) =>
    `The ${slot} could not be checked because its declared pattern is not valid.`,
  "pattern budget": (_check, slot) =>
    `The ${slot} could not be checked against its declared pattern in time.`,
};

function checkSay<R extends Rule>(check: CheckOf<R>, slot: string): string {
  return checkWords[check.rule](check, slot);
}

const words: {
  readonly [K in Kind]: (fault: FaultOf<K>, cli: string) => string;
} = {
  "no-command": (_fault, cli) =>
    `No command was given. Run ${cli} --help to list the commands.`,
  invalid: () => "The invocation is not valid for the selected command.",
  "unknown-command": () => "No declared command matches this invocation.",
  "navigation-conflict": () =>
    "Use only one of --help, --discover, --discover-all and --discover-command.",
  "navigation-shape": () =>
    "Give --help, --discover or --discover-all alone, or --discover-command with one command identity.",
  deadline: () =>
    "The option --deadline-ms needs one positive whole number of milliseconds.",
  "deadline-unsupported": () => "This command does not accept --deadline-ms.",
  "root-input": () => "This command needs at least one option or argument.",
  "later-step": () =>
    "A value in this invocation cannot be passed on to this command's next step.",
  "unknown-option": (fault) => {
    const subject = unknownOptionSubject(fault.option);
    return fault.closest === null
      ? `The invocation uses ${subject} this command does not declare.`
      : `The invocation uses ${subject} this command does not declare. Did you mean ${fault.closest.name}?`;
  },
  "unexpected-value": (fault) => `The ${label(fault.slot)} takes no value.`,
  "extra-argument": () =>
    "The invocation has more arguments than this command accepts.",
  missing: (fault) => `The required ${label(fault.slot)} is missing.`,
  "missing-value": (fault) => `The ${label(fault.slot)} needs a value.`,
  repeated: (fault) => `The ${label(fault.slot)} can be given only once.`,
  value: (fault) => checkSay(fault.check, label(fault.slot)),
  requires: (fault) =>
    `The ${label(fault.slot)} needs the ${label(fault.needs)} as well.`,
  exclusive: (fault) =>
    `The ${label(fault.slots[0])} and the ${label(fault.slots[1])} cannot be used together.`,
};

function say<K extends Kind>(fault: FaultOf<K>, cli: string): string {
  return words[fault.kind](fault, cli);
}

export function usageRefusal(fault: UsageFault, cli: string) {
  return {
    causeCode:
      fault.kind === "unknown-command"
        ? ("USAGE_UNKNOWN_COMMAND" satisfies keyof typeof commonCauses)
        : ("USAGE_INVALID_INVOCATION" satisfies keyof typeof commonCauses),
    message: say(fault, cli),
  } as const;
}
