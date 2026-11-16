import type { CommandDeclaration, CommandSummary } from "./declarations.ts";
import { emptyInput } from "./input.ts";
import type { DeclaredStation } from "./stations.ts";
import type { CauseTable, Handoff, NextStep } from "./types.ts";
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
function kernelRepair(causeCode: string, success: boolean): string | null {
  if (success) return null;
  return causeCode === "DOMAIN_AUTHORITY_REQUIRED"
    ? "Obtain an exact-item grant from the command's authority owner, then decide on a new run."
    : "Inspect the command, its input and independently observable resource before a new run.";
}
function kernelWords(
  causeCode: string,
  command: CommandDeclaration,
  cli: string,
):
  | { readonly next: NextStep; readonly handoff?: never }
  | { readonly handoff: Handoff; readonly next?: never } {
  // CMD-15 and WIRE-18: every approval denial is one handoff naming the
  // authority owner. The base names that owner's role; a command that needs a
  // specific owner declares this tuple with its own words (DISC-11b).
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
  return { next: { kind: "command", command: `${cli}.help`, args: [] } };
}
// DISC-10 and DISC-11: the causes the base adds to a host command, in
// publication order. A handler may select any of them that the fallback does
// not reserve (DISC-11b, K1-6).
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
  return addKernelStations(command, cli, causes, needed);
}
function addKernelStations(
  command: CommandDeclaration,
  cli: string,
  causes: CauseTable,
  needed: readonly string[],
): readonly DeclaredStation[] {
  const entries = [...command.stations];
  for (const causeCode of needed) {
    if (entries.some((entry) => entry.causeCode === causeCode)) continue;
    const row = causes[causeCode];
    if (!row) throw new Error("Missing common cause.");
    entries.push({
      commandIdentity: command.commandIdentity,
      causeCode,
      row,
      trigger:
        causeCode === "SUCCESS_UNCHANGED"
          ? command.summary
          : `Kernel ${causeCode}.`,
      guidance: kernelWords(causeCode, command, cli),
      repairAction: kernelRepair(causeCode, row.outcome === "success"),
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
