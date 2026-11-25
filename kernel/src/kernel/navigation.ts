import type { CommandDeclaration, CommandSummary } from "./declarations.ts";
import { emptyInput } from "./input.ts";
import type { DeclaredStation } from "./stations.ts";
import type { CauseTable, Handoff, NextStep } from "./types.ts";
import { commonCauses } from "./causes.ts";
import { exits } from "./types.ts";
import {
  deadlineCause,
  internalResultCause,
  internalResultCode,
} from "./state-causes.ts";
export function builtins(cli: string): readonly CommandDeclaration[] {
  return [
    {
      commandIdentity: `${cli}.help`,
      route: ["--help"],
      summary: "Show help.",
    },
    {
      commandIdentity: `${cli}.discovery`,
      route: ["--discover"],
      summary: "Discover commands.",
    },
    {
      commandIdentity: `${cli}.full-discovery`,
      route: ["--discover-all"],
      summary: "Discover all commands.",
    },
    {
      commandIdentity: `${cli}.command-discovery`,
      route: ["--discover-command"],
      summary: "Discover one command.",
    },
    {
      commandIdentity: `${cli}.dispatch`,
      route: [],
      summary: "Resolve an invocation.",
    },
  ].map((item) => ({
    ...item,
    effectClass: "inspect",
    input:
      item.commandIdentity === `${cli}.command-discovery`
        ? {
            ...emptyInput,
            arguments: [
              {
                name: "commandIdentity",
                summary: "Canonical command identity.",
                required: true,
                value: {
                  kind: "string",
                  minLength: 1,
                  maxLength: 128,
                  choices: null,
                  pattern: null,
                },
              },
            ],
          }
        : emptyInput,
    stations: [],
    capabilities: {},
  }));
}
export function summary(command: CommandDeclaration): CommandSummary {
  return {
    commandIdentity: command.commandIdentity,
    route: command.route,
    ...(command.renamedFrom !== undefined && command.renamedFrom.length > 0
      ? { renamedFrom: command.renamedFrom.map((route) => [...route]) }
      : {}),
    summary: command.summary,
    effectClass: command.effectClass,
  };
}
const authorityWords = {
  handoff: {
    owner: "human",
    reason:
      "This command needs an exact-item grant from its authority owner before it can run.",
    inspect: [
      {
        kind: "instruction",
        text: "Authority owner: review the requested item and decide whether to grant it.",
      },
    ],
  },
} as const satisfies { readonly handoff: Handoff };
const deadlineWords = {
  repair: "Inspect the deadline and the input before deciding on a new run.",
  next: "Inspect the deadline and the input, then explicitly decide whether to start a new run.",
} as const;
const instructionWords: Partial<
  Record<
    keyof typeof commonCauses,
    { readonly repair: string; readonly next: string }
  >
> = {
  USAGE_UNKNOWN_COMMAND: {
    repair: "Use a command identity this CLI declares.",
    next: "Select a command identity from availablePaths, then run that command's route.",
  },
  INTERNAL_PREPARATION: {
    repair: "Repair the CLI or its runtime before another run.",
    next: "Repair the CLI or its runtime, then decide whether to start another run.",
  },
  DOMAIN_DEADLINE_BEFORE_START: deadlineWords,
  [deadlineCause.unchanged]: deadlineWords,
};
function instructionFor(causeCode: string) {
  return Object.entries(instructionWords).find(
    ([code]) => code === causeCode,
  )?.[1];
}
function helpStep(cli: string): NextStep {
  return { kind: "command", command: `${cli}.help`, args: [] };
}
export function discoverable(identity: string): boolean {
  return !identity.startsWith("-") && !/[{}]/u.test(identity);
}
type HostStep = { readonly repair: string; readonly next: NextStep };
const hostSteps: Partial<
  Record<
    keyof typeof commonCauses,
    (identity: string, cli: string) => HostStep | undefined
  >
> = {
  USAGE_INVALID_INVOCATION: (identity, cli) =>
    discoverable(identity)
      ? {
          repair: "Correct the invocation using this command's discovery.",
          next: {
            kind: "command",
            command: `${cli}.command-discovery`,
            args: [identity],
          },
        }
      : undefined,
};
function hostStepFor(
  causeCode: string,
  identity: string,
  cli: string,
): HostStep | undefined {
  return Object.entries(hostSteps).find(([code]) => code === causeCode)?.[1]?.(
    identity,
    cli,
  );
}
function kernelRepair(
  causeCode: string,
  success: boolean,
  hostStep: HostStep | undefined,
): string | null {
  if (success) return null;
  if (causeCode === "DOMAIN_AUTHORITY_REQUIRED")
    return "Obtain an exact-item grant from the command's authority owner, then decide on a new run.";
  return (
    instructionFor(causeCode)?.repair ??
    hostStep?.repair ??
    "Inspect the command, its input and independently observable resource before a new run."
  );
}
function kernelWords(
  causeCode: string,
  command: CommandDeclaration,
  cli: string,
  hostStep: HostStep | undefined,
):
  | { readonly next: NextStep; readonly handoff?: never }
  | { readonly handoff: Handoff; readonly next?: never } {
  if (causeCode === "DOMAIN_AUTHORITY_REQUIRED") return authorityWords;
  if (
    internalResultCode(causeCode) ||
    [
      deadlineCause.completed,
      deadlineCause["partially-completed"],
      deadlineCause.unknown,
    ].some((cause) => cause === causeCode)
  )
    return {
      handoff: {
        owner: "operator",
        reason:
          "Inspect result production and independently confirmed effects.",
        inspect: command.ifNoResult
          ? [command.ifNoResult.step]
          : [
              {
                kind: "instruction",
                text: "Inspect the command's resource and retained history without repeating its operation.",
              },
            ],
      },
    };
  if (causeCode === "SUCCESS_UNCHANGED") return { next: { kind: "done" } };
  const instruction = instructionFor(causeCode);
  if (instruction)
    return { next: { kind: "instruction", text: instruction.next } };
  return { next: hostStep?.next ?? helpStep(cli) };
}
export function hostKernelCauses(command: CommandDeclaration): string[] {
  const needed = [
    ...(command.stations.length === 0 ? ["SUCCESS_UNCHANGED"] : []),
    "USAGE_INVALID_INVOCATION",
    ...(command.input.arguments.length + command.input.options.length > 0
      ? ["SCHEMA_INVALID_INPUT"]
      : []),
    "INTERNAL_PREPARATION",
    internalResultCause.unchanged,
  ];
  addEffectStations(command, needed);
  return needed;
}
function builtinKernelCauses(
  command: CommandDeclaration,
  cli: string,
): string[] {
  const needed = ["INTERNAL_PREPARATION", internalResultCause.unchanged];
  if (command.commandIdentity === `${cli}.dispatch`)
    needed.unshift("USAGE_INVALID_INVOCATION", "USAGE_UNKNOWN_COMMAND");
  else needed.unshift("SUCCESS_UNCHANGED");
  if (command.commandIdentity === `${cli}.command-discovery`)
    needed.unshift("USAGE_UNKNOWN_COMMAND");
  addEffectStations(command, needed);
  return needed;
}
export function stationsFor(
  command: CommandDeclaration,
  cli: string,
  causes: CauseTable,
): readonly DeclaredStation[] {
  const builtin = builtins(cli).some(
    (item) => item.commandIdentity === command.commandIdentity,
  );
  const needed = builtin
    ? builtinKernelCauses(command, cli)
    : hostKernelCauses(command);
  return addKernelStations(command, cli, causes, needed, !builtin);
}
function addKernelStations(
  command: CommandDeclaration,
  cli: string,
  causes: CauseTable,
  needed: readonly string[],
  host: boolean,
): readonly DeclaredStation[] {
  const entries = [...command.stations];
  for (const causeCode of needed) {
    if (entries.some((entry) => entry.causeCode === causeCode)) continue;
    const row = causes[causeCode];
    if (!row) throw new Error("Missing common cause.");
    const hostStep = host
      ? hostStepFor(causeCode, command.commandIdentity, cli)
      : undefined;
    entries.push({
      commandIdentity: command.commandIdentity,
      causeCode,
      row,
      trigger:
        causeCode === "SUCCESS_UNCHANGED"
          ? command.summary
          : `Kernel ${causeCode}.`,
      guidance: kernelWords(causeCode, command, cli, hostStep),
      repairAction: kernelRepair(
        causeCode,
        row.outcome === "success",
        hostStep,
      ),
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: `kernel:${command.commandIdentity}:${causeCode}`,
    });
  }
  return entries;
}
export function publicStation(
  station: DeclaredStation,
  effectClass: CommandSummary["effectClass"],
) {
  const { independentObservable: _evidence, row, ...words } = station;
  void _evidence;
  const { guidance: _arm, ...fixed } = row;
  void _arm;
  return { ...words, ...fixed, effectClass };
}
export const exitMeanings = Object.fromEntries(
  Object.entries(exits).map(([meaning, code]) => [code, meaning] as const),
);
export const signalExits = { "130": "SIGINT", "143": "SIGTERM" } as const;

function addEffectStations(
  command: CommandDeclaration,
  needed: string[],
): void {
  if (command.effectClass !== "inspect") {
    needed.push(internalResultCause.completed, internalResultCause.unknown);
    if ((command.effects?.length ?? 0) > 1)
      needed.push(internalResultCause["partially-completed"]);
  }
  if (command.input.deadlineSupported) {
    needed.push("DOMAIN_DEADLINE_BEFORE_START", deadlineCause.unchanged);
    if (command.effectClass !== "inspect")
      needed.push(deadlineCause.completed, deadlineCause.unknown);
    if ((command.effects?.length ?? 0) > 1)
      needed.push(deadlineCause["partially-completed"]);
  }
  if (command.capabilities.approval) needed.push("DOMAIN_AUTHORITY_REQUIRED");
}
