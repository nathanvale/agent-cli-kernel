import { resolveInvocation } from "./routing.ts";
import { authority, resource, path } from "./validation/brands.ts";
import type { CommandDeclaration } from "./declarations.ts";
import { parseInput } from "./input.ts";
import {
  builtins,
  exitMeanings,
  publicStation,
  signalExits,
  stationsFor,
  summary,
} from "./navigation.ts";
import { commonCauses } from "./causes.ts";
import type { DeclaredStation } from "./stations.ts";
import { classifyVersion } from "./validation/version.ts";
import { validateEnvelope } from "./validation/envelope.ts";
import { renderGuidance } from "./guidance.ts";
import { wireResult } from "./validation/result.ts";

export { command, changing } from "./declarations.ts";
export { station } from "./stations.ts";
export { commonCauses } from "./causes.ts";
export function contractFor(spec: {
  readonly cli: string;
  readonly commands: readonly CommandDeclaration[];
}) {
  const commands = [...spec.commands, ...builtins(spec.cli)].sort((a, b) =>
    a.commandIdentity < b.commandIdentity ? -1 : 1,
  );
  if (
    new Set(commands.map((item) => item.commandIdentity)).size !==
    commands.length
  )
    throw new Error("Duplicate command identity.");
  if (
    new Set(
      commands
        .filter((item) => item.commandIdentity !== `${spec.cli}.dispatch`)
        .map((item) => JSON.stringify(item.route)),
    ).size !==
    commands.length - 1
  )
    throw new Error("Duplicate command route.");
  const stationMap = new Map(
    commands.map((item) => [
      item.commandIdentity,
      stationsFor(item, spec.cli, commonCauses),
    ]),
  );
  function validate(value: unknown) {
    return validateEnvelope(value, commonCauses, commands, stationMap);
  }

  return {
    boundary: { authority, resource, path },
    cli: spec.cli,
    causes: commonCauses,
    classifyVersion,
    validate,
    resolve(argv: unknown) {
      return resolveInvocation(spec.cli, commands, argv);
    },
    help() {
      return {
        usage: `${spec.cli} <command> [options]`,
        summary: `Commands for ${spec.cli}.`,
        commands: spec.commands.map(summary),
        options: [
          {
            name: "--json",
            valueName: null,
            summary: "Emit one machine-readable result.",
          },
          { name: "--help", valueName: null, summary: "Show help." },
          {
            name: "--discover",
            valueName: null,
            summary: "Discover commands.",
          },
          {
            name: "--discover-command",
            valueName: "identity",
            summary: "Discover one command.",
          },
        ],
      };
    },
    discover() {
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
    },
    discoverCommand(identity: string) {
      const item = commands.find((entry) => entry.commandIdentity === identity);
      return item
        ? {
            command: summary(item),
            semantics: "possible-outcomes",
            ifNoResult: null,
            input: item.input,
            stations: (stationMap.get(identity) ?? []).map((entry) =>
              publicStation(entry, item.effectClass),
            ),
          }
        : undefined;
    },
    async parse(identity: string, argv: unknown) {
      const item = commands.find((entry) => entry.commandIdentity === identity);
      return item
        ? parseInput(item.input, argv)
        : ({
            ok: false,
            path: "commandIdentity",
            reason: "unknown command",
          } as const);
    },
    async build(
      selected: DeclaredStation,
      facts: Readonly<Record<string, unknown>>,
    ) {
      const station = stationMap
        .get(selected.commandIdentity)
        ?.find((item) => item.causeCode === selected.causeCode);
      const command = commands.find(
        (item) => item.commandIdentity === selected.commandIdentity,
      );
      if (!command || !station)
        return {
          ok: false,
          path: "station",
          reason: "undeclared station",
        } as const;
      const { guidance: arm, ...row } = station.row;
      void arm;
      const runFacts: Record<string, unknown> = {};
      for (const key of [
        "runId",
        "data",
        "effects",
        "retryDelayMilliseconds",
        "attemptedEffect",
        "idempotencyKey",
        "bindings",
      ])
        if (key in facts) runFacts[key] = facts[key];
      const result = {
        ...runFacts,
        ...row,
        commandIdentity: station.commandIdentity,
        causeCode: station.causeCode,
        effectClass: command.effectClass,
        repairAction: station.repairAction,
        ...station.guidance,
      };
      if (!wireResult(result))
        return {
          ok: false,
          path: "facts",
          reason: "invalid run facts",
        } as const;
      try {
        return await validate({
          contractVersion: "3.0.0",
          message: facts.message,
          availablePaths: commands.map((item) => item.commandIdentity),
          result: { ...result, ...renderGuidance(station, result) },
        });
      } catch {
        return {
          ok: false,
          path: "bindings",
          reason: "invalid template values",
        } as const;
      }
    },
  };
}
export type {
  AuthorityId,
  ResourceId,
  ParsedPath,
  IfNoResult,
  RecordedEffect,
  TransactionProof,
  EffectTransaction,
  StateCapability,
  ProgramRequest,
  ProgramResult,
  ProgramHandle,
  ProgramsCapability,
  ApprovalCapability,
  DiagnosticsCapability,
  CapabilitySelection,
  HandlerContext,
  StateIssuer,
  RunProcess,
} from "./capabilities.ts";
export type {
  CauseRow,
  CauseTable,
  ResultFor,
  WireResult,
  Envelope,
  JsonValue,
  Handoff,
  CommandStep,
  NextStep,
  Effects,
  Diagnostics,
  Validation,
  Outcome,
  TransactionState,
  EffectClass,
  FailureClass,
  ExitCode,
} from "./types.ts";
export type {
  InputSchema,
  ParsedInput,
  ValueSchema,
  ArgumentSchema,
  OptionSchema,
  Constraint,
} from "./input-types.ts";
export type { CommandDeclaration, CommandSummary } from "./declarations.ts";
export type {
  DeclaredStation,
  StationInput,
  RetryDelayPolicy,
} from "./stations.ts";
