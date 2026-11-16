// One owner for the inspect-only declarations of the swarm-triage cases
// (X-K1-*). The in-process admission tests and the process CLI
// (swarm-cli.ts) both import them, so the declaration a test admits is the
// declaration the child process runs. Expected values live in the tests.
import {
  command,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
import { emptyInput, unchanged } from "./shapes.ts";

function text(maxLength: number, pattern: string | null) {
  return {
    kind: "string",
    minLength: 1,
    maxLength,
    choices: null,
    pattern,
  } as const;
}

// X-K1-1: one inspect command whose required operand declares `pattern`.
export function patternShow(pattern: string) {
  return command({
    identity: "x.show",
    route: ["show"],
    summary: "Show one value.",
    input: {
      ...emptyInput,
      arguments: [
        {
          name: "value",
          summary: "Value.",
          required: true,
          value: text(20, pattern),
        },
      ],
    },
    capabilities: {},
    run: (input, context) =>
      context.result(
        { commandIdentity: "x.show", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Shown.", data: { value: input.value }, effects: unchanged },
      ),
  });
}

// Process scenarios run by swarm-cli.ts; each reads its variant from the
// environment the parent test sets.
export const scenarios: Readonly<Record<string, () => object>> = {
  pattern: () =>
    contractFor({
      cli: "x",
      commands: [patternShow(process.env.PATTERN ?? "")],
    }),
};
