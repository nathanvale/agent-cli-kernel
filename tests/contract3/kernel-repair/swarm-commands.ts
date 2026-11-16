// One owner for the inspect-only declarations of the swarm-triage cases
// (X-K1-*). The in-process admission tests and the process CLI
// (swarm-cli.ts) both import them, so the declaration a test admits is the
// declaration the child process runs. Expected values live in the tests.
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import { emptyInput, unchanged } from "./shapes.ts";

const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
  independentObservable: "swarm-cli",
} as const;
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

// X-K1-2: x.show with one required value-taking option `--title`.
export function titledShow() {
  return command({
    identity: "x.show",
    route: ["show"],
    summary: "Show a title.",
    input: {
      ...emptyInput,
      options: [
        {
          name: "--title",
          aliases: [],
          summary: "Title.",
          required: true,
          repeatable: false,
          value: text(20, null),
        },
      ],
    },
    capabilities: {},
    run: (input, context) =>
      context.result(
        { commandIdentity: "x.show", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Shown.",
          data: { title: input["--title"] },
          effects: unchanged,
        },
      ),
  });
}

// X-K1-13: x.show with one optional operand.
export function filterShow() {
  return command({
    identity: "x.show",
    route: ["show"],
    summary: "Show a filter.",
    input: {
      ...emptyInput,
      arguments: [
        {
          name: "filter",
          summary: "Filter.",
          required: false,
          value: text(20, null),
        },
      ],
    },
    capabilities: {},
    run: (input, context) =>
      context.result(
        { commandIdentity: "x.show", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Shown.",
          data: { filter: input.filter ?? null },
          effects: unchanged,
        },
      ),
  });
}

// The success station of x.go: its next step is `TARGET ARGS`.
export function goStation(args: readonly string[], target = "x.show") {
  return station(commonCauses, {
    commandIdentity: "x.go",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Went.",
    guidance: { next: { kind: "command", command: target, args: [...args] } },
    repairAction: null,
    ...words,
  });
}

// x.go: one inspect command whose only success names `TARGET ARGS`.
export function go(args: readonly string[], target = "x.show") {
  const went = goStation(args, target);
  return command({
    identity: "x.go",
    route: ["go"],
    summary: "Go.",
    input: emptyInput,
    capabilities: {},
    stations: [went],
    run: (_input, context) =>
      context.result(went, {
        message: "Went.",
        data: null,
        effects: unchanged,
      }),
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
  "navigation-value": () =>
    contractFor({
      cli: "x",
      commands: [titledShow(), go(["--title", process.env.VALUE ?? ""])],
    }),
  "json-after-delimiter": () =>
    contractFor({ cli: "x", commands: [filterShow(), go(["--", "--json"])] }),
};
