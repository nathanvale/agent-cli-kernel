import type { commonCauses } from "./causes.ts";

export type UsageFault =
  | { readonly kind: "no-command" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unknown-command" };
type Kind = UsageFault["kind"];
type FaultOf<K extends Kind> = Extract<UsageFault, { readonly kind: K }>;

const words: {
  readonly [K in Kind]: (fault: FaultOf<K>, cli: string) => string;
} = {
  "no-command": (_fault, cli) =>
    `No command was given. Run ${cli} --help to list the commands.`,
  invalid: () => "The invocation is not valid for the selected command.",
  "unknown-command": () => "No declared command matches this invocation.",
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
