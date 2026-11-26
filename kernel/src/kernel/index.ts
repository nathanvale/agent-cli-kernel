import { navigationData } from "./validation/discovery.ts";
import { resultPlan, resultMatches } from "./command-result.ts";
import type { CommandResult, Invocation } from "./command-result.ts";
import { withState } from "./validation/context.ts";
import { buildInputTable, validateFutureInputs } from "./future-input.ts";
import { validateCauses, validateCommands } from "./declaration-checks.ts";
import type {
  ValidatedCommands,
  ValidatedStation,
  RunFacts,
  AddonName,
} from "./declaration-checks.ts";
import {
  isStateDescriptor,
  createStateAddon,
  attachState,
  closeAtDeadline,
  issuedProof,
  issuedSuperseded,
  proofFreeResultAllowed,
} from "./state-seam.ts";
import type { StateAddonDescriptor } from "./state-seam.ts";
import type { CauseTable, Effects, Validation } from "./types.ts";
import { proofValue } from "./validation/state.ts";
import {
  invocationRoute,
  invocationTokens,
  refused,
  resolveInvocation,
} from "./routing.ts";
import { recordRuntime } from "./runtime.ts";
import type { Attach, Enter, KernelFacts } from "./runtime.ts";
import { authority, resource, path } from "./validation/brands.ts";
import type { CommandDeclaration } from "./declarations.ts";
import { preparerOf } from "./declarations.ts";
import type { DeclaredStation } from "./stations.ts";
import { parseInput, acceptsRootInput } from "./input.ts";
import { builtins, stationsFor } from "./navigation.ts";
import { freeze } from "./stations.ts";
import { commonCauses } from "./causes.ts";

import { classifyVersion, contractVersion } from "./validation/version.ts";
import { validateEnvelope } from "./validation/envelope.ts";
import { renderGuidance } from "./guidance.ts";
import { wireResult } from "./validation/result.ts";
import { stepVectorProblem } from "./step-vector.ts";
import { record, text } from "./validation/primitives.ts";

export { command, changing } from "./declarations.ts";
export { runInProcess, runProcess } from "./lifecycle.ts";
export { scriptedTerminal } from "./terminal.ts";
export type {
  AttachedAddon,
  EmergencyFacts,
  InProcessResult,
  InProcessSetup,
  RunInProcess,
  RunAddon,
  RunControl,
  RunSetup,
  TerminalAdapter,
} from "./process-types.ts";
export { station } from "./stations.ts";
export { issuedScope } from "./state-seam.ts";
export { commonCauses } from "./causes.ts";
export const defaultCommandDisclosure =
  "Runs when the CLI's name is typed alone in a terminal.";
function validateDefaultCommand(
  cli: string,
  hostCommands: readonly CommandDeclaration[],
  candidate: CommandDeclaration,
): CommandDeclaration {
  const builtinIdentities = builtins(cli).map((item) => item.commandIdentity);
  const identity =
    record(candidate) && typeof candidate.commandIdentity === "string"
      ? candidate.commandIdentity
      : undefined;
  if (identity !== undefined && builtinIdentities.includes(identity))
    throw new Error(`defaultCommand cannot name built-in command ${identity}.`);
  if (!hostCommands.includes(candidate))
    throw new Error("defaultCommand must be one of the declared commands.");
  const problem = stepVectorProblem(candidate, [], true);
  if (problem)
    throw new Error(
      `defaultCommand ${candidate.commandIdentity} cannot run with no arguments: ${problem}.`,
    );
  if (!candidate.summary.includes(defaultCommandDisclosure))
    throw new Error(
      `defaultCommand ${candidate.commandIdentity} summary must include "${defaultCommandDisclosure}".`,
    );
  return candidate;
}
function validateVersion(version: unknown): string | null {
  if (version === undefined) return null;
  if (!text(version))
    throw new Error(
      "Invalid CLI version. Repair: pass a non-empty string for version, or omit it.",
    );
  return version;
}
export function contractFor<
  const Cli extends string,
  const D extends readonly CommandDeclaration[],
>(spec: {
  readonly cli: Cli;
  readonly version?: string;
  readonly commands: D & ValidatedCommands<D, Cli>;
  readonly defaultCommand?: NoInfer<D[number]>;
  readonly state?: StateAddonDescriptor;
  readonly causes?: CauseTable;
  readonly installedAddons?: readonly AddonName[];
}) {
  freeze(spec);
  const cliVersion = validateVersion(spec.version);
  const installed = spec.installedAddons ?? [];
  if (!commandsArray(spec.commands))
    throw new Error("Host callbacks never receive a state issuer.");
  if (
    installed.includes("state") &&
    (!spec.state || !isStateDescriptor(spec.state))
  )
    throw new Error(
      "State requires the descriptor created by contractFor.stateAddon.",
    );
  if (
    spec.state &&
    (!installed.includes("state") || !isStateDescriptor(spec.state))
  )
    throw new Error(
      "State is not in installedAddons, or its descriptor was not created by contractFor.stateAddon.",
    );
  if (installed.includes("approval") && !installed.includes("state"))
    throw new Error(
      "Approval requires the state add-on: list state in installedAddons and pass the add-on made by contractFor.stateAddon.",
    );
  const hostCommands = [...spec.commands];
  const causes: typeof commonCauses & CauseTable = structuredClone({
    ...commonCauses,
    ...spec.causes,
  });
  freeze(causes);
  validateCauses(causes);
  const builtinCommands = builtins(spec.cli);
  const commands: CommandDeclaration[] = [
    ...hostCommands,
    ...builtinCommands,
  ].sort((a, b) => (a.commandIdentity < b.commandIdentity ? -1 : 1));
  validateCommands(spec.cli, commands, causes, installed);
  const defaultCommand =
    spec.defaultCommand === undefined
      ? undefined
      : validateDefaultCommand(spec.cli, hostCommands, spec.defaultCommand);
  if (
    spec.state &&
    commands.some(
      (item) =>
        item.effectClass !== "inspect" &&
        item.ifNoResult !== spec.state?.ifNoResult,
    )
  )
    throw new Error(
      "A changing command's ifNoResult step comes from a different state add-on descriptor.",
    );
  freeze(commands);
  const commandListIdentities = new Set(
    builtinCommands
      .map((item) => item.commandIdentity)
      .filter((identity) => identity !== `${spec.cli}.dispatch`),
  );
  const allPaths = commands.map((item) => item.commandIdentity);
  const inputTable = buildInputTable(commands);
  const stationMap = new Map(
    commands.map((item) => [
      item.commandIdentity,
      freeze(stationsFor(item, spec.cli, causes)),
    ]),
  );
  const acceptedResults = new WeakSet<object>();
  const forgetters = new WeakMap<Enter, () => void>();
  const navigation = navigationData(spec.cli, commands, stationMap, cliVersion);
  async function validate(value: unknown) {
    const checked = await validateEnvelope(
      spec.cli,
      value,
      causes,
      commands,
      stationMap,
    );
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

  async function assemble(
    command: CommandDeclaration,
    station: DeclaredStation,
    runFacts: Readonly<Record<string, unknown>>,
    message: unknown,
  ) {
    const { guidance: arm, ...rest } = station.row;
    void arm;
    const carriesData = Reflect.get(rest, "carriesData") === true;
    if (
      station.row.outcome !== "success" &&
      !carriesData &&
      runFacts.data !== null
    )
      return {
        ok: false,
        path: "facts.data",
        reason: "non-null data requires a success row or carriesData: true",
      } as const;
    const row = Object.fromEntries(
      Object.entries(rest).filter(([key]) => key !== "carriesData"),
    );
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
    const availablePaths =
      commandListIdentities.has(station.commandIdentity) ||
      station.causeCode ===
        ("USAGE_UNKNOWN_COMMAND" satisfies keyof typeof commonCauses)
        ? allPaths
        : [];
    try {
      return await validate({
        contractVersion,
        message,
        availablePaths,
        result: { ...result, ...renderGuidance(station, result) },
      });
    } catch {
      return {
        ok: false,
        path: "bindings",
        reason: "invalid run binding values",
      } as const;
    }
  }

  const undeclared = {
    ok: false,
    path: "station",
    reason: "undeclared station",
  } as const;

  function applyTransactionProof(
    runFacts: Record<string, unknown>,
    facts: Readonly<Record<string, unknown>>,
    runId: unknown,
    station: DeclaredStation,
  ) {
    const proof = Object.hasOwn(facts, "transaction")
      ? Reflect.get(facts, "transaction")
      : undefined;
    if (
      typeof runId !== "string" ||
      !proofValue(proof, runId, spec.state) ||
      proof.transactionState !== station.row.transactionState
    )
      return {
        ok: false,
        path: "transaction",
        reason: "state-issued transaction proof required",
      } as const;
    runFacts.effects = proof.effects;
    return undefined;
  }

  function applyChangingState(
    command: CommandDeclaration,
    station: DeclaredStation,
    runFacts: Record<string, unknown>,
    facts: Readonly<Record<string, unknown>>,
    runId: unknown,
  ) {
    if (command.effectClass === "inspect") return undefined;
    if (station.row.outcome !== "refused") {
      const problem = applyTransactionProof(runFacts, facts, runId, station);
      if (problem) return problem;
    } else if (
      typeof runId === "string" &&
      !proofFreeResultAllowed(runId, spec.state)
    )
      return {
        ok: false,
        path: "transaction",
        reason: "a transaction on this run requires its proof",
      } as const;
    if (typeof runId === "string") {
      const superseded = issuedSuperseded(runId, spec.state);
      if (superseded !== undefined) runFacts.superseded = superseded;
    }
    return undefined;
  }

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
      if (Object.hasOwn(facts, key)) runFacts[key] = Reflect.get(facts, key);
    const problem = applyChangingState(
      command,
      station,
      runFacts,
      facts,
      runFacts.runId,
    );
    if (problem) return problem;
    const message = Object.hasOwn(facts, "message")
      ? Reflect.get(facts, "message")
      : undefined;
    return assemble(command, station, runFacts, message);
  }

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
      {
        runId: facts.runId,
        data: facts.data,
        effects,
        ...(facts.superseded === undefined
          ? {}
          : { superseded: facts.superseded }),
      },
      facts.message,
    );
  }

  async function prepareCommand(
    identity: string,
    argv: unknown,
    runId: string,
    context: unknown = {},
  ): Promise<Validation<Attach>> {
    const selected = commands.find(
      (entry) => entry.commandIdentity === identity,
    );
    if (!selected?.execute)
      return {
        ok: false,
        path: "commandIdentity",
        reason: "unknown executable command",
      };
    const parsed = await parseInput(selected.input, argv);
    if (!parsed.ok) return parsed;
    const future = await validateFutureInputs(
      selected,
      parsed.value,
      inputTable,
    );
    if (!future.ok) return future;
    const changingCommand = selected.effectClass !== "inspect";
    const invocation = Object.freeze({});
    const prepare = preparerOf(selected);
    const ready = prepare
      ? await prepare(argv, context, runId, invocation, inputTable)
      : undefined;
    if (ready && !ready.ok) return ready;
    const execute = selected.execute;
    let used = false;
    const attach: Attach = () => {
      if (used)
        return {
          ok: false,
          path: "entry",
          reason: "handler entry already used",
        };
      used = true;
      const attached =
        changingCommand && spec.state
          ? attachState(
              spec.state,
              runId,
              selected.effects ?? [],
              selected.commandIdentity,
            )
          : undefined;
      if (changingCommand && spec.state && !attached)
        return {
          ok: false,
          path: "runId",
          reason: "run identity already attached",
        };
      const enter: Enter = async () => {
        const outcome = await (ready
          ? ready.value(attached?.capability)
          : execute(
              argv,
              changingCommand
                ? withState(context, attached?.capability)
                : context,
              runId,
              invocation,
              inputTable,
            )
        ).finally(() => attached?.close());
        return accepted(outcome, identity, runId, invocation, parsed);
      };
      if (attached) forgetters.set(enter, attached.forget);
      return { ok: true, value: enter };
    };
    return { ok: true, value: attach };
  }

  function accepted(
    outcome: Validation<CommandResult>,
    identity: string,
    runId: string,
    invocation: Invocation,
    parsed: { readonly deadlineMilliseconds?: number },
  ) {
    if (!outcome.ok) return outcome;
    if (!resultMatches(outcome.value, identity, runId, invocation))
      return {
        ok: false,
        path: "result",
        reason: "result belongs to another invocation",
      } as const;
    acceptedResults.add(outcome.value);
    return parsed.deadlineMilliseconds === undefined
      ? outcome
      : { ...outcome, deadlineMilliseconds: parsed.deadlineMilliseconds };
  }

  async function executeCommand(
    identity: string,
    argv: unknown,
    runId: string,
    context: unknown = {},
  ) {
    const prepared = await prepareCommand(identity, argv, runId, context);
    if (!prepared.ok) return prepared;
    const entry = prepared.value();
    return entry.ok ? entry.value() : entry;
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
    version: navigation.version,
    discover: navigation.discover,
    discoverAll: navigation.discoverAll,
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
    build<const S extends ValidatedStation<D>>(
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
  recordRuntime(contract, {
    cli: spec.cli,
    commands,
    stations: stationMap,
    async resolve(argv: unknown, facts) {
      const resolved = await resolveInvocation(spec.cli, commands, argv, {
        interactive: facts?.interactive === true,
        ...(defaultCommand === undefined ? {} : { defaultCommand }),
      });
      if (!resolved.ok) return resolved;
      const raw: readonly unknown[] = Array.isArray(argv) ? argv : [];
      const selected = commands.find(
        (item) => item.commandIdentity === resolved.value.commandIdentity,
      );
      if (
        selected &&
        !(
          await validateFutureInputs(selected, resolved.value.input, inputTable)
        ).ok
      )
        return refused(
          spec.cli,
          { kind: "later-step" },
          resolved.value.machine,
          selected.commandIdentity,
        );
      const argvStrings = raw.map((token) =>
        typeof token === "string" ? token : "",
      );
      const matched = invocationRoute(spec.cli, commands, argvStrings);
      const tokens = invocationTokens(argvStrings);
      return {
        ok: true,
        value: {
          ...resolved.value,
          args: tokens.slice(matched.routeLength),
          ...(matched.renamedHelp ? { renamedHelp: true } : {}),
        },
      };
    },
    navigation: {
      help: navigation.help,
      version: navigation.version,
      discover: navigation.discover,
      discoverAll: navigation.discoverAll,
      discoverCommand: navigation.discoverCommand,
    },
    execute: (identity, argv, runId, context) =>
      executeCommand(identity, argv, runId, context),
    prepare: (identity, argv, runId, context) =>
      prepareCommand(identity, argv, runId, context),
    buildKernelStation,
    buildResult: (result) => contract.buildResult(result),
    validate,
    trustedSummary: (runId) => issuedProof(runId, spec.state),
    trustedSuperseded: (runId) => issuedSuperseded(runId, spec.state),
    closeStateAtDeadline: (runId) => closeAtDeadline(runId, spec.state),
    forgetState: (enter) => forgetters.get(enter)?.(),
  });
  return contract;
}
export type {
  AuthorityId,
  ResourceId,
  ParsedPath,
  IfNoResult,
  OpenWrite,
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
  DiagnosticsLevel,
  MenuCapability,
  MenuResult,
  MenuRow,
  CapabilitySelection,
  HandlerContext,
  AbortContext,
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

// Interface: State add-on factory seam. Source rules permit references only in the
// exact pinned state add-on; ordinary host wiring passes its
// opaque descriptor. This is not a same-process isolation guarantee.
contractFor.stateAddon = createStateAddon;
export type {
  StateAddonDescriptor,
  StateFactoryResult,
  StateObservation,
  ExclusiveScope,
} from "./state-seam.ts";
export type { ApprovalRequest, ApprovalRuntime } from "./capabilities.ts";

export type {
  RunFacts,
  ValidatedStation,
  ValidatedCommands,
  CommandIdentity,
  InspectIdentity,
} from "./declaration-checks.ts";

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
export type { InputTable } from "./future-input.ts";
