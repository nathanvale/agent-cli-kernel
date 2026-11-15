export type ValueSchema =
  | {
      readonly kind: "string";
      readonly minLength: number;
      readonly maxLength: number;
      readonly choices: readonly string[] | null;
      readonly pattern: string | null;
    }
  | {
      readonly kind: "integer";
      readonly minimum: number;
      readonly maximum: number;
    };
export type ArgumentSchema = {
  readonly name: string;
  readonly summary: string;
  readonly required: boolean;
  readonly value: ValueSchema;
};
export type OptionSchema = {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly value: ValueSchema | null;
};
export type Constraint =
  | {
      readonly kind: "requires";
      readonly ifPresent: string;
      readonly thenPresent: string;
    }
  | { readonly kind: "exclusive"; readonly members: readonly string[] };
export type InputSchema = {
  readonly arguments: readonly ArgumentSchema[];
  readonly options: readonly OptionSchema[];
  readonly constraints: readonly Constraint[];
  readonly deadlineSupported: boolean;
  readonly additionalArguments: false;
  readonly additionalOptions: false;
};
export type ValueType<V> = V extends null
  ? boolean
  : V extends { kind: "integer" }
    ? number
    : string;
export type SlotValue<S extends ArgumentSchema | OptionSchema> = ValueType<
  S["value"]
>;
export type ParsedSlot<S extends ArgumentSchema | OptionSchema> = S extends {
  repeatable: true;
}
  ? readonly SlotValue<S>[]
  : SlotValue<S>;
export type Slots<I extends InputSchema> =
  | I["arguments"][number]
  | I["options"][number];
export type ParsedInput<I extends InputSchema> = {
  readonly [S in Slots<I> as S["required"] extends true
    ? S["name"]
    : never]: ParsedSlot<S>;
} & {
  readonly [S in Slots<I> as S["required"] extends true
    ? never
    : S["name"]]?: ParsedSlot<S>;
};
