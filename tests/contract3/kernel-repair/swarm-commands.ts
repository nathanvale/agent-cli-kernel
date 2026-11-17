import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import {
  authority,
  resource,
} from "../../../starters/contract3/src/kernel/validation/brands.ts";
import { readsUnchanged } from "./handlers.ts";
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

export function goStation(args: readonly string[]) {
  return station(commonCauses, {
    commandIdentity: "x.go",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Went.",
    guidance: { next: { kind: "command", command: "x.show", args: [...args] } },
    repairAction: null,
    ...words,
  });
}

export function go(args: readonly string[]) {
  const went = goStation(args);
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

export function selectingLoad(causeCode: string, ownStation: boolean): object {
  const run = (_input: unknown, context: unknown) => {
    const result: unknown =
      typeof context === "object" && context !== null
        ? Reflect.get(context, "result")
        : undefined;
    if (typeof result !== "function") throw new Error("No result builder.");
    const selected: unknown = Reflect.apply(result, context, [
      { commandIdentity: "x.load", causeCode },
      {
        message: "The persisted record has a bad shape.",
        data: null,
        effects: unchanged,
      },
    ]);
    return selected;
  };
  const loaded = station(commonCauses, {
    commandIdentity: "x.load",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Loaded.",
    guidance: { next: { kind: "done" } },
    repairAction: null,
    ...words,
  });
  const spec = {
    identity: "x.load",
    route: ["load"],
    summary: "Load a persisted record.",
    input: {
      ...emptyInput,
      arguments: [
        {
          name: "id",
          summary: "Record id.",
          required: true,
          value: text(20, null),
        },
      ],
    },
    capabilities: {},
  };
  const declaration: unknown = Reflect.apply(command, undefined, [
    ownStation ? { ...spec, stations: [loaded], run } : { ...spec, run },
  ]);
  const contract: unknown = Reflect.apply(contractFor, undefined, [
    { cli: "x", commands: [declaration] },
  ]);
  if (typeof contract !== "object" || contract === null)
    throw new Error("Expected a contract.");
  return contract;
}
function schemaLoad(): object {
  return selectingLoad("SCHEMA_INVALID_INPUT", false);
}

function deadlineRead() {
  return command({
    identity: "x.read",
    route: ["read"],
    summary: "Read.",
    input: {
      ...emptyInput,
      deadlineSupported: true,
      options: [
        {
          name: "--all",
          aliases: [],
          summary: "All.",
          required: false,
          repeatable: false,
          value: null,
        },
      ],
    },
    capabilities: {},
    run: readsUnchanged("x.read"),
  });
}

export function approvedRead(entered: () => void) {
  const read = station(commonCauses, {
    commandIdentity: "x.read",
    causeCode: "SUCCESS_UNCHANGED",
    trigger: "Read the granted item.",
    guidance: { next: { kind: "done" } },
    repairAction: null,
    ...words,
  });
  return command({
    identity: "x.read",
    route: ["read"],
    summary: "Read one granted item.",
    input: emptyInput,
    capabilities: { approval: true },
    approval: () => ({
      authority: authority("x.owner"),
      resource: resource("x.item"),
      resourceRevision: "1",
      effects: [],
      preview: "preview-1",
    }),
    stations: [read],
    run: (_input, context) => {
      entered();
      return context.result(read, {
        message: "Read.",
        data: null,
        effects: unchanged,
      });
    },
  });
}

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
  "schema-station": schemaLoad,
  "default-words": () => contractFor({ cli: "x", commands: [deadlineRead()] }),
  "json-after-delimiter": () =>
    contractFor({ cli: "x", commands: [filterShow(), go(["--", "--json"])] }),
};
