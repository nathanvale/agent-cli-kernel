import type { CommandDeclaration, CommandSummary } from "./declarations.ts";
import { emptyInput } from "./input.ts";
import type { DeclaredStation } from "./stations.ts";
import type { CauseTable, Handoff, NextStep } from "./types.ts";
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
function kernelWords(
  causeCode: string,
  command: CommandDeclaration,
  cli: string,
):
  | { readonly next: NextStep; readonly handoff?: never }
  | { readonly handoff: Handoff; readonly next?: never } {
  if (
    causeCode.startsWith("INTERNAL_RESULT_") ||
    [
      "DOMAIN_AUTHORITY_REQUIRED",
      "DOMAIN_DEADLINE_COMPLETED",
      "DOMAIN_DEADLINE_PARTIAL",
      "DOMAIN_DEADLINE_UNKNOWN",
    ].includes(causeCode)
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
export function stationsFor(
  command: CommandDeclaration,
  cli: string,
  causes: CauseTable,
): readonly DeclaredStation[] {
  const host = ![
    `${cli}.help`,
    `${cli}.discovery`,
    `${cli}.command-discovery`,
    `${cli}.dispatch`,
  ].includes(command.commandIdentity);
  const needed = host
    ? [
        "USAGE_INVALID_INVOCATION",
        ...(command.input.arguments.length + command.input.options.length > 0
          ? ["SCHEMA_INVALID_INPUT"]
          : []),
        "INTERNAL_PREPARATION",
        "INTERNAL_RESULT_UNCHANGED",
      ]
    : ["INTERNAL_PREPARATION", "INTERNAL_RESULT_UNCHANGED"];
  if (command.commandIdentity === `${cli}.dispatch`)
    needed.unshift("USAGE_INVALID_INVOCATION", "USAGE_UNKNOWN_COMMAND");
  else if (!host || command.stations.length === 0)
    needed.unshift("SUCCESS_UNCHANGED");
  if (command.commandIdentity === `${cli}.command-discovery`)
    needed.unshift("USAGE_UNKNOWN_COMMAND");
  addEffectStations(command, needed);
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
      repairAction:
        row.outcome === "success"
          ? null
          : "Inspect the command, its input and independently observable resource before a new run.",
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
export const exitMeanings = {
  "0": "success",
  "1": "internal",
  "2": "usage",
  "3": "domain",
  "4": "schema",
  "75": "transient",
} as const;
export const signalExits = { "130": "SIGINT", "143": "SIGTERM" } as const;

function addEffectStations(
  command: CommandDeclaration,
  needed: string[],
): void {
  if (command.effectClass !== "inspect") {
    needed.push("INTERNAL_RESULT_COMPLETED", "INTERNAL_RESULT_UNKNOWN");
    if ((command.effects?.length ?? 0) > 1)
      needed.push("INTERNAL_RESULT_PARTIAL");
  }
  if (command.input.deadlineSupported) {
    needed.push("DOMAIN_DEADLINE_BEFORE_START", "DOMAIN_DEADLINE_UNCHANGED");
    if (command.effectClass !== "inspect")
      needed.push("DOMAIN_DEADLINE_COMPLETED", "DOMAIN_DEADLINE_UNKNOWN");
    if ((command.effects?.length ?? 0) > 1)
      needed.push("DOMAIN_DEADLINE_PARTIAL");
  }
  if (command.capabilities.approval) needed.push("DOMAIN_AUTHORITY_REQUIRED");
}
