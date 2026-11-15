import { deadlineOption } from "../deadline.ts";
import type { CommandDeclaration } from "../declarations.ts";
import {
  exitMeanings,
  publicStation,
  signalExits,
  summary,
} from "../navigation.ts";
import type { DeclaredStation } from "../stations.ts";
import type { WireResult } from "../types.ts";
import { json, record } from "./primitives.ts";

// Catalogue order is not a contract constraint. Argument and route order is.
const unordered = new Set([
  "commands",
  "options",
  "stations",
  "effectExclusions",
  "aliases",
  "constraints",
  "members",
]);

function canonical(value: unknown, key = ""): string {
  if (Array.isArray(value)) {
    const entries: unknown[] = Array.from(value);
    const encoded = entries.map((entry) => canonical(entry));
    return `array:${JSON.stringify(unordered.has(key) ? encoded.sort() : encoded)}`;
  }
  if (record(value))
    return `object:${JSON.stringify(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => [name, canonical(entry, name)]),
    )}`;
  return `scalar:${JSON.stringify(value) ?? ""}`;
}

function sameProjection(actual: unknown, expected: unknown): boolean {
  return (
    json(actual) && json(expected) && canonical(actual) === canonical(expected)
  );
}

export function navigationData(
  cli: string,
  commands: readonly CommandDeclaration[],
  stations: ReadonlyMap<string, readonly DeclaredStation[]>,
) {
  const builtinIdentities = new Set([
    `${cli}.help`,
    `${cli}.discovery`,
    `${cli}.command-discovery`,
    `${cli}.dispatch`,
  ]);
  function help() {
    return {
      usage: `${cli} <command> [options]`,
      summary: `Commands for ${cli}.`,
      commands: commands
        .filter((command) => !builtinIdentities.has(command.commandIdentity))
        .map(summary),
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
          name: "--discover-command",
          valueName: "identity",
          summary: "Discover one command.",
        },
      ],
    };
  }
  function discover() {
    return {
      contractVersion: "3.0.0",
      commands: commands.map(summary),
      exitMeanings,
      signalExits,
      effectExclusions: [
        "Incidental journal maintenance.",
        "Incidental diagnostic maintenance.",
      ],
    };
  }
  function discoverCommand(identity: string) {
    const command = commands.find(
      (entry) => entry.commandIdentity === identity,
    );
    return command
      ? {
          command: summary(command),
          semantics: "possible-outcomes",
          ifNoResult: command.ifNoResult?.step ?? null,
          input: command.input,
          stations: (stations.get(identity) ?? []).map((station) =>
            publicStation(station, command.effectClass),
          ),
        }
      : undefined;
  }
  function validData(result: WireResult): boolean {
    if (result.outcome !== "success") return true;
    if (result.commandIdentity === `${cli}.help`)
      return sameProjection(result.data, help());
    if (result.commandIdentity === `${cli}.discovery`)
      return sameProjection(result.data, discover());
    if (result.commandIdentity !== `${cli}.command-discovery`) return true;
    const data: unknown = result.data;
    if (!record(data) || !record(data.command)) return false;
    const identity = data.command.commandIdentity;
    return (
      typeof identity === "string" &&
      sameProjection(data, discoverCommand(identity))
    );
  }
  return { help, discover, discoverCommand, validData };
}
