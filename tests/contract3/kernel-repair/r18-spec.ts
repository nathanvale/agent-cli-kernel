import type * as Kernel from "../../../kernel/src/kernel/index.ts";
import type {
  CommandDeclaration,
  DeclaredStation,
  InputSchema,
} from "../../../kernel/src/kernel/index.ts";
import { runtimeOf } from "../../../kernel/src/kernel/runtime.ts";
import { emptyInput } from "./shapes.ts";

export type KernelValues = Pick<
  typeof Kernel,
  "command" | "station" | "commonCauses"
>;
const base = emptyInput;
const text = {
  kind: "string",
  minLength: 1,
  maxLength: 64,
  choices: null,
  pattern: null,
} as const;
const operand = (
  name: string,
  value: InputSchema["arguments"][number]["value"] = text,
) => ({
  name,
  summary: `Operand ${name}.`,
  required: true,
  value,
});
const flag = (
  name: string,
  repeatable = false,
  value: typeof text | null = null,
) => ({
  name,
  aliases: [],
  summary: `Option ${name}.`,
  required: false,
  repeatable,
  value,
});
const inputs: Readonly<Record<string, InputSchema>> = {
  T2op: { ...base, arguments: [operand("a"), operand("b")] },
  Tint: {
    ...base,
    arguments: [operand("n", { kind: "integer", minimum: 1, maximum: 10 })],
  },
  Tmode: {
    ...base,
    arguments: [operand("mode", { ...text, choices: ["fast", "slow"] })],
  },
  Topt: {
    ...base,
    options: [
      { ...flag("--target", false, text), required: true },
      flag("--dry"),
      flag("--tag", true, text),
    ],
    constraints: [
      { kind: "requires", ifPresent: "--dry", thenPresent: "--target" },
      { kind: "exclusive", members: ["--dry", "--tag"] },
    ],
  },
  Troot: { ...base, options: [flag("--all")] },
  Tdl: {
    ...base,
    arguments: [{ ...operand("item"), required: false }],
    deadlineSupported: true,
  },
  Tnodl: { ...base, arguments: [{ ...operand("item"), required: false }] },
};
const routes: Readonly<Record<string, readonly string[]>> = {
  T2op: ["two"],
  Tint: ["int"],
  Tmode: ["mode"],
  Topt: ["opt"],
  Troot: [],
  Tdl: ["deadline"],
  Tnodl: ["nodeadline"],
};
const targetIdentity = (name: string) => `specimen.${name.toLowerCase()}`;
export function targets(kernel: KernelValues): CommandDeclaration[] {
  return Object.keys(inputs).map((name) =>
    kernel.command({
      identity: targetIdentity(name),
      route: routes[name] ?? [name],
      summary: `Target ${name}.`,
      input: inputs[name] ?? base,
      capabilities: {},
      run: () => {
        throw new Error("R18 targets are never executed.");
      },
    }),
  );
}

export type Row = {
  readonly target: string;
  readonly args: readonly string[];
  readonly callerOwned?: string;
};
export const rows: Readonly<Record<string, Row>> = {
  "r1.missing-operand-caller": {
    target: "T2op",
    args: ["{binding.item}"],
    callerOwned: "item",
  },
  "r2.missing-operand-runtime": { target: "T2op", args: ["{runId}"] },
  "r3.extra-operand": { target: "T2op", args: ["x", "{runId}", "z"] },
  "r4.required-option-absent": { target: "Topt", args: ["{binding.v}"] },
  "r5.option-missing-value": { target: "Topt", args: ["--target"] },
  "r6.unknown-option": {
    target: "Topt",
    args: ["--target", "{runId}", "--nope"],
  },
  "r7.repeated-flag": {
    target: "Topt",
    args: ["--target", "{runId}", "--dry", "--dry"],
  },
  "r8.requires-violated": { target: "Topt", args: ["--dry"] },
  "r9.exclusive-violated": {
    target: "Topt",
    args: ["--target", "{runId}", "--dry", "--tag", "{runId}"],
  },
  "r10.root-empty": { target: "Troot", args: [] },
  "r11.literal-invalid-value": { target: "Tint", args: ["0"] },
  "r12.literal-not-choice": { target: "Tmode", args: ["medium"] },
  "r13.deadline-unsupported": {
    target: "Tnodl",
    args: ["--deadline-ms", "{binding.d}"],
  },
  "r14.deadline-literal-invalid": {
    target: "Tdl",
    args: ["--deadline-ms", "abc"],
  },
  "r15.separator-shift": {
    target: "T2op",
    args: ["--", "--x", "{runId}", "z"],
  },
  "r16.repeated-deadline": {
    target: "Tdl",
    args: ["--deadline-ms", "10", "--deadline-ms", "20"],
  },
  "a1.valid-twin": {
    target: "T2op",
    args: ["{binding.item}", "{runId}"],
    callerOwned: "item",
  },
  "a2.literal-valid": {
    target: "Topt",
    args: ["--target", "main", "--tag", "a", "--tag", "b"],
  },
  "a3.runtime-owned": {
    target: "Topt",
    args: ["--target", "{runId}", "--dry"],
  },
  "a4.value-dependent-integer": {
    target: "Tint",
    args: ["{binding.count}"],
    callerOwned: "count",
  },
  "a5.value-dependent-runtime": { target: "Tmode", args: ["{runId}"] },
  "a6.root-with-flag": { target: "Troot", args: ["--all"] },
  "a7.deadline-templated": {
    target: "Tdl",
    args: ["--deadline-ms", "{binding.d}"],
  },
  "a8.separator-literal": { target: "T2op", args: ["--", "--x", "{runId}"] },
};

export const sourceInput = {
  ...base,
  options: [flag("--item", false, text), flag("--count", false, text)],
} as const;
export const hold = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;
const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "r18-step",
} as const;
export function stepStation(
  kernel: KernelValues,
  source: string,
  arm: "next" | "handoff",
  row: Row,
): DeclaredStation {
  const step = {
    kind: "command",
    command: targetIdentity(row.target),
    args: [...row.args],
  } as const;
  const causes = { ...kernel.commonCauses, HOLD: hold };
  return arm === "next"
    ? kernel.station(causes, {
        commandIdentity: source,
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Step source.",
        guidance: { next: step },
        repairAction: null,
        ...words,
      })
    : kernel.station(causes, {
        commandIdentity: source,
        causeCode: "HOLD",
        trigger: "Held source.",
        guidance: {
          handoff: { owner: "operator", reason: "Inspect.", inspect: [step] },
        },
        repairAction: "Inspect the target.",
        ...words,
      });
}
export const futureBindings = (row: Row): Readonly<Record<string, string>> =>
  row.callerOwned ? { [row.callerOwned]: `--${row.callerOwned}` } : {};

export type Observation = {
  readonly admitted: boolean;
  readonly namesStep: boolean;
  readonly templateShown: boolean;
};
export function observe(
  admit: () => unknown,
  source: string,
  row: Row,
): Observation {
  try {
    const contract = admit();
    const view: unknown =
      typeof contract === "object" && contract !== null
        ? runtimeOf(contract)?.navigation.discoverCommand(source)
        : undefined;
    const shown = JSON.stringify(view).includes(
      JSON.stringify({
        kind: "command",
        command: targetIdentity(row.target),
        args: row.args,
      }),
    );
    return { admitted: true, namesStep: false, templateShown: shown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      admitted: false,
      namesStep: message.includes(targetIdentity(row.target)),
      templateShown: false,
    };
  }
}
