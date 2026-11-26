import { deadlineOption } from "../deadline.ts";
import type { CommandDeclaration } from "../declarations.ts";
import {
  builtins,
  exitMeanings,
  publicStation,
  signalExits,
  summary,
} from "../navigation.ts";
import type { DeclaredStation } from "../stations.ts";
import { freeze } from "../stations.ts";
import type { WireResult } from "../types.ts";
import { record } from "./primitives.ts";
import { sameJson } from "./json-equality.ts";

const unordered = new Set([
  "commands",
  "options",
  "stations",
  "effectExclusions",
  "aliases",
  "constraints",
  "members",
]);

function sameProjection(actual: unknown, expected: unknown): boolean {
  return sameJson(actual, expected, unordered);
}

function withoutProse(station: ReturnType<typeof publicStation>) {
  const {
    trigger: _trigger,
    guidance: _guidance,
    repairAction: _repairAction,
    ...rest
  } = station;
  void _trigger;
  void _guidance;
  void _repairAction;
  return rest;
}

export function navigationData(
  cli: string,
  commands: readonly CommandDeclaration[],
  stations: ReadonlyMap<string, readonly DeclaredStation[]>,
) {
  const builtinIdentities = new Set(
    builtins(cli).map((item) => item.commandIdentity),
  );
  function help() {
    return {
      usage: `${cli} <command> [options]`,
      summary: `Commands for ${cli}.`,
      commands: commands.flatMap((command) =>
        builtinIdentities.has(command.commandIdentity)
          ? []
          : [summary(command)],
      ),
      options: [
        ...(commands.some((command) => command.input.deadlineSupported)
          ? [deadlineOption]
          : []),
        {
          name: "--json",
          valueName: null,
          summary: "Emit one machine-readable result.",
        },
        { name: "--help", valueName: null, summary: "Show help." },
        { name: "--discover", valueName: null, summary: "Discover commands." },
        {
          name: "--discover-all",
          valueName: null,
          summary: "Discover all commands.",
        },
        {
          name: "--discover-command",
          valueName: "identity",
          summary: "Discover one command.",
        },
      ],
    };
  }
  function commandEntry(command: CommandDeclaration) {
    return {
      command: summary(command),
      semantics: "possible-outcomes" as const,
      ifNoResult: command.ifNoResult?.step ?? null,
      input: command.input,
      stations: (stations.get(command.commandIdentity) ?? []).map((station) =>
        publicStation(station, command.effectClass),
      ),
    };
  }
  function discover() {
    return freeze({
      contractVersion: "3.0.0",
      commands: commands.map(summary),
      exitMeanings: { ...exitMeanings },
      signalExits: { ...signalExits },
      effectExclusions: [
        "Incidental journal maintenance.",
        "Incidental diagnostic maintenance.",
      ],
    });
  }
  function discoverAll() {
    return freeze({
      contractVersion: "3.0.0",
      stationProseSource:
        "Run --discover-command <identity> for trigger, guidance and repairAction.",
      commands: commands.map((command) => {
        const entry = commandEntry(command);
        return {
          ...entry,
          stations: entry.stations.map(withoutProse),
        };
      }),
      exitMeanings: { ...exitMeanings },
      signalExits: { ...signalExits },
      effectExclusions: [
        "Incidental journal maintenance.",
        "Incidental diagnostic maintenance.",
      ],
    });
  }
  function discoverCommand(identity: string) {
    const command = commands.find(
      (entry) => entry.commandIdentity === identity,
    );
    return command ? freeze(commandEntry(command)) : undefined;
  }
  function validData(result: WireResult): boolean {
    if (result.outcome !== "success") return true;
    if (result.commandIdentity === `${cli}.help`)
      return sameProjection(result.data, help());
    if (result.commandIdentity === `${cli}.discovery`)
      return sameProjection(result.data, discover());
    if (result.commandIdentity === `${cli}.full-discovery`)
      return sameProjection(result.data, discoverAll());
    if (result.commandIdentity !== `${cli}.command-discovery`) return true;
    const data: unknown = result.data;
    if (!record(data) || !record(data.command)) return false;
    const identity = data.command.commandIdentity;
    return (
      typeof identity === "string" &&
      sameProjection(data, discoverCommand(identity))
    );
  }
  return { help, discover, discoverAll, discoverCommand, validData };
}
