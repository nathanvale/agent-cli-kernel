import { navigationData } from "./validation/discovery.ts";
import { resultPlan, resultMatches } from "./command-result.ts";
import type { CommandResult } from "./command-result.ts";
import { withState } from "./validation/context.ts";
import { registerInputs, validateFutureInputs } from "./future-input.ts";
import { admitCauses, admitCommands } from "./registration.ts";
import type {
  RegisteredCommands,
  RegisteredStation,
  RunFacts,
  AddonName,
} from "./registration.ts";
import { admittedState, createStateAddon, attachState } from "./state-seam.ts";
import type { StateAddonDescriptor } from "./state-seam.ts";
import type { CauseTable, Effects } from "./types.ts";
import { proofValue } from "./validation/state.ts";
import { invocationTokens, resolveInvocation } from "./routing.ts";
import { registerRuntime } from "./runtime.ts";
import type { KernelFacts } from "./runtime.ts";
import { authority, resource, path } from "./validation/brands.ts";
import type { CommandDeclaration } from "./declarations.ts";
import type { DeclaredStation } from "./stations.ts";
import { parseInput, acceptsRootInput } from "./input.ts";
import { builtins, stationsFor } from "./navigation.ts";
import { freeze } from "./stations.ts";
import { commonCauses } from "./causes.ts";

import { classifyVersion } from "./validation/version.ts";
import { validateEnvelope } from "./validation/envelope.ts";
import { renderGuidance } from "./guidance.ts";
import { wireResult } from "./validation/result.ts";

export { command, changing } from "./declarations.ts";
export { runProcess } from "./lifecycle.ts";
export type {
  AttachedAddon,
  EmergencyFacts,
  RunAddon,
  RunControl,
  RunSetup,
} from "./process-types.ts";
export { station } from "./stations.ts";
export { commonCauses } from "./causes.ts";
export function contractFor<
  const Cli extends string,
  const D extends readonly CommandDeclaration[],
>(spec: {
  readonly cli: Cli;
  readonly commands: D & RegisteredCommands<D, Cli>;
  readonly state?: StateAddonDescriptor;
  readonly causes?: CauseTable;
  readonly installedAddons?: readonly AddonName[];
}) {
  freeze(spec);
  const installed = spec.installedAddons ?? [];
  if (!commandsArray(spec.commands))
    throw new Error("Host callbacks never receive a state issuer.");
  if (
    installed.includes("state") &&
    (!spec.state || !admittedState(spec.state))
  )
    throw new Error("State requires its admitted stamped descriptor.");
  if (
    spec.state &&
    (!installed.includes("state") || !admittedState(spec.state))
  )
    throw new Error("State descriptor is not installed or admitted.");
  const hostCommands = [...spec.commands];
  const causes: typeof commonCauses & CauseTable = structuredClone({
    ...commonCauses,
    ...spec.causes,
  });
  freeze(causes);
  admitCauses(causes);
  const commands: CommandDeclaration[] = [
    ...hostCommands,
    ...builtins(spec.cli),
  ].sort((a, b) => (a.commandIdentity < b.commandIdentity ? -1 : 1));
  admitCommands(spec.cli, commands, causes, installed);
  if (
    spec.state &&
    commands.some(
      (item) =>
        item.effectClass !== "inspect" &&
        item.ifNoResult !== spec.state?.ifNoResult,
    )
  )
    throw new Error("Recovery route belongs to another state installation.");
  freeze(commands);
  const inputRegistration = registerInputs(commands);
  const stationMap = new Map(
    commands.map((item) => [
      item.commandIdentity,
      stationsFor(item, spec.cli, causes),
    ]),
  );
  const acceptedResults = new WeakSet<object>();
  const navigation = navigationData(spec.cli, commands, stationMap);
  async function validate(value: unknown) {
    const checked = await validateEnvelope(value, causes, commands, stationMap);
    return checked.ok && !navigation.validData(checked.value.result)
      ? ({
          ok: false,
          path: "result.data",
          reason: "invalid navigation data",
        } as const)
      : checked;
  }

  function stationOf(selected: {
    readonly commandIdentity: string;
    readonly causeCode: string;
  }) {
    const station = stationMap
      .get(selected.commandIdentity)
      ?.find((item) => item.causeCode === selected.causeCode);
    const command = commands.find(
      (item) => item.commandIdentity === selected.commandIdentity,
    );
    return command && station ? { command, station } : undefined;
  }

  // Assembles and validates one envelope from a declared station and the
  // run facts already admitted by the caller.
  async function assemble(
    command: CommandDeclaration,
    station: DeclaredStation,
    runFacts: Readonly<Record<string, unknown>>,
    message: unknown,
  ) {
    const { guidance: arm, ...row } = station.row;
    void arm;
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
        message,
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
  }

  const undeclared = {
    ok: false,
    path: "station",
    reason: "undeclared station",
  } as const;

  async function buildRegistered(
    selected: { readonly commandIdentity: string; readonly causeCode: string },
    facts: Readonly<Record<string, unknown>>,
  ) {
    const found = stationOf(selected);
    if (!found) return undeclared;
    const { command, station } = found;
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
      if (key in facts) runFacts[key] = Reflect.get(facts, key);
    if (
      command.effectClass !== "inspect" &&
      station.row.outcome !== "refused"
    ) {
      const proof = facts.transaction;
      if (
        typeof facts.runId !== "string" ||
        !proofValue(proof, facts.runId, spec.state) ||
        proof.transactionState !== station.row.transactionState
      )
        return {
          ok: false,
          path: "transaction",
          reason: "state-issued transaction proof required",
        } as const;
      runFacts.effects = proof.effects;
    }
    return assemble(command, station, runFacts, facts.message);
  }

  // Kernel-selected stations only (usage, deadline and navigation results).
  // The kernel supplies effects from its own observation; this builder is
  // reachable only through the private runtime record, never from `build`.
  async function buildKernelStation(
    selected: { readonly commandIdentity: string; readonly causeCode: string },
    facts: KernelFacts,
    effects: Effects,
  ) {
    const found = stationOf(selected);
    if (!found) return undeclared;
    return assemble(
      found.command,
      found.station,
      { runId: facts.runId, data: facts.data, effects },
      facts.message,
    );
  }

  async function executeCommand(
    identity: string,
    argv: unknown,
    runId: string,
    context: unknown = {},
  ) {
    const selected = commands.find(
      (entry) => entry.commandIdentity === identity,
    );
    if (!selected?.execute)
      return {
        ok: false,
        path: "commandIdentity",
        reason: "unknown executable command",
      } as const;
    const parsed = await parseInput(selected.input, argv);
    if (!parsed.ok) return parsed;
    const future = await validateFutureInputs(
      selected,
      parsed.value,
      inputRegistration,
    );
    if (!future.ok) return future;
    const executionContext =
      selected.effectClass === "inspect"
        ? context
        : withState(
            context,
            spec.state
              ? attachState(spec.state, runId, selected.effects ?? [])
              : undefined,
          );
    const invocation = Object.freeze({});
    const outcome = await selected.execute(
      argv,
      executionContext,
      runId,
      invocation,
      inputRegistration,
    );
    if (!outcome.ok) return outcome;
    if (!resultMatches(outcome.value, identity, runId, invocation))
      return {
        ok: false,
        path: "result",
        reason: "result belongs to another invocation",
      } as const;
    acceptedResults.add(outcome.value);
    return {
      ...outcome,
      ...(parsed.deadlineMilliseconds === undefined
        ? {}
        : { deadlineMilliseconds: parsed.deadlineMilliseconds }),
    };
  }

  const contract = {
    boundary: { authority, resource, path },
    execute(
      identity: D[number]["commandIdentity"],
      argv: unknown,
      runId: string,
      context: unknown = {},
    ) {
      return executeCommand(identity, argv, runId, context);
    },
    cli: spec.cli,
    causes,
    classifyVersion,
    validate,
    resolve(argv: unknown) {
      return resolveInvocation(spec.cli, commands, argv);
    },
    help: navigation.help,
    discover: navigation.discover,
    discoverCommand: navigation.discoverCommand,
    async parse(identity: string, argv: unknown) {
      const item = commands.find((entry) => entry.commandIdentity === identity);
      if (!item)
        return {
          ok: false,
          path: "commandIdentity",
          reason: "unknown command",
        } as const;
      const parsed = await parseInput(item.input, argv);
      return parsed.ok && !acceptsRootInput(item.route, parsed.value)
        ? ({
            ok: false,
            path: "input",
            reason: "root operation requires a command-specific input",
          } as const)
        : parsed;
    },
    build<const S extends RegisteredStation<D>>(
      selected: S,
      facts: RunFacts<NoInfer<S>, D>,
    ) {
      return buildRegistered(selected, facts);
    },
    buildResult(result: CommandResult) {
      const plan = acceptedResults.has(result) ? resultPlan(result) : undefined;
      return plan
        ? buildRegistered(plan.selected, plan.facts)
        : Promise.resolve({
            ok: false,
            path: "result",
            reason: "unknown command result",
          } as const);
    },
  };
  registerRuntime(contract, {
    cli: spec.cli,
    commands,
    stations: stationMap,
    async resolve(argv: unknown) {
      const resolved = await resolveInvocation(spec.cli, commands, argv);
      if (!resolved.ok) return resolved;
      const raw: readonly unknown[] = Array.isArray(argv) ? argv : [];
      const selected = commands.find(
        (item) => item.commandIdentity === resolved.value.commandIdentity,
      );
      // CMD-9 step 3: caller-supplied future bindings are input too, so they
      // are refused before the deadline check (step 4) and any preflight.
      if (
        selected &&
        !(
          await validateFutureInputs(
            selected,
            resolved.value.input,
            inputRegistration,
          )
        ).ok
      )
        return {
          ok: false,
          commandIdentity: selected.commandIdentity,
          causeCode: "USAGE_INVALID_INVOCATION",
          machine: resolved.value.machine,
        } as const;
      const route = selected?.route ?? [];
      const tokens = invocationTokens(
        raw.map((token) => (typeof token === "string" ? token : "")),
      );
      return {
        ok: true,
        value: { ...resolved.value, args: tokens.slice(route.length) },
      };
    },
    navigation: {
      help: navigation.help,
      discover: navigation.discover,
      discoverCommand: navigation.discoverCommand,
    },
    execute: (identity, argv, runId, context) =>
      executeCommand(identity, argv, runId, context),
    buildKernelStation,
    buildResult: (result) => contract.buildResult(result),
    validate,
    trustedSummary(result, runId) {
      const proof: unknown = acceptedResults.has(result)
        ? resultPlan(result)?.facts.transaction
        : undefined;
      return proofValue(proof, runId, spec.state) ? proof : undefined;
    },
  });
  return contract;
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

// Supporting stamped-add-on authoring seam. Source admission permits references
// only in the exact pinned state add-on; ordinary host composition passes its
// opaque descriptor. This is not a same-process isolation guarantee.
contractFor.stateAddon = createStateAddon;
export type {
  StateAddonDescriptor,
  StateRegistration,
  StateObservation,
  ExclusiveScope,
} from "./state-seam.ts";
export type { ApprovalRequest, ApprovalRuntime } from "./capabilities.ts";

export type {
  RunFacts,
  RegisteredStation,
  RegisteredCommands,
  CommandIdentity,
  InspectIdentity,
} from "./registration.ts";

export { exits } from "./types.ts";
export { versionReader } from "./validation/version.ts";
export type { MinorFields } from "./validation/version.ts";

function commandsArray(value: unknown): boolean {
  return Array.isArray(value);
}

export type {
  CommandResult,
  ResultContext,
  AllowedCause,
  SelectedRow,
} from "./command-result.ts";
export type { InputRegistration } from "./future-input.ts";
