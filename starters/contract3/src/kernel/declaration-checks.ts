import {
  declaredStationKeys,
  reservedFallbackCause,
  validateWords,
} from "./stations.ts";
import { builtins } from "./navigation.ts";
import type { CommandDeclaration } from "./declarations.ts";
import {
  admitChangingShape,
  validateCommandIdentity,
  admitInspectShape,
  preparerOf,
  validateRootOperation,
  validateRouteTokens,
} from "./declarations.ts";
import { commonCauses } from "./causes.ts";
import type { CauseTable } from "./types.ts";
import { causeRow } from "./validation/result.ts";
import { bindingNames, guidanceTargets } from "./guidance.ts";
import { validateHostInput } from "./host-input.ts";
import { carriesGlobalSwitch } from "./routing.ts";
import { stepVectorProblem } from "./step-vector.ts";
import { keys, record, text } from "./validation/primitives.ts";
export type AddonName = "state" | "programs" | "approval" | "diagnostics";
export function validateCauses(causes: CauseTable): void {
  for (const [code, row] of Object.entries(causes)) {
    if (!text(code) || !causeRow(row)) throw new Error("Invalid cause row.");
  }
  for (const [code, expected] of Object.entries(commonCauses)) {
    const actual = causes[code];
    if (
      !actual ||
      Object.entries(expected).some(
        ([key, value]) => Reflect.get(actual, key) !== value,
      )
    )
      throw new Error("Common cause rows cannot be replaced.");
  }
}
function validateStationSet(
  command: CommandDeclaration,
  causes: CauseTable,
): void {
  const seen = new Set<string>();
  for (const station of command.stations) {
    if (
      !record(station) ||
      !keys(station, declaredStationKeys) ||
      !causeRow(station.row)
    )
      throw new Error("Station is not a strict declared station.");
    // DISC-11b: the fallback's stations keep the base's fixed words (F12).
    if (reservedFallbackCause(station.causeCode))
      throw new Error("Fallback station words are reserved.");
    const row = causes[station.causeCode];
    if (
      !row ||
      station.commandIdentity !== command.commandIdentity ||
      seen.has(station.causeCode)
    )
      throw new Error(
        "Station identity is undeclared, duplicated or bound to another command.",
      );
    if (
      Object.entries(row).some(
        ([key, value]) => Reflect.get(station.row, key) !== value,
      )
    )
      throw new Error("Station disagrees with the CLI cause owner.");
    if (
      command.effectClass === "inspect" &&
      row.transactionState !== "unchanged"
    )
      throw new Error("Inspect stations are unchanged.");
    validateWords(station, row);
    bindingNames(station);
    seen.add(station.causeCode);
  }
}
function validateIfNoResult(
  command: CommandDeclaration,
  commands: readonly CommandDeclaration[],
): void {
  if (command.effectClass === "inspect") return;
  const route = command.ifNoResult?.step;
  const target = commands.find(
    (item) => item.commandIdentity === route?.command,
  );
  if (!route || !target || target.effectClass !== "inspect")
    throw new Error("ifNoResult must name a declared inspect command.");
  // DISC-13 and DISC-14(1): the step is a command step (STEP-6) checked when
  // the command is declared, because the base copies it into the fallback;
  // a step its target cannot parse would leave the fallback unproducible.
  // The same global-switch rule as every station step (INPUT-3, STEP-6):
  // a switch value would route the copied step to navigation (B1).
  if (carriesGlobalSwitch(route.args))
    throw new Error(
      `ifNoResult step ${target.commandIdentity} ${JSON.stringify(route.args)} carries a global switch before --.`,
    );
  const problem = stepVectorProblem(target, route.args, true);
  if (problem)
    throw new Error(
      `ifNoResult step ${target.commandIdentity} ${JSON.stringify(route.args)} can never parse: ${problem}.`,
    );
  const success = target.stations.find(
    (item) => item.row.outcome === "success",
  );
  if (!success || success.guidance.next?.kind === "done")
    throw new Error("ifNoResult needs explicit further inspection guidance.");
  for (const cause of [command.heldLockCause, command.unresolvedCaseCause]) {
    // CMD-10 and CMD-12: each coordination refusal has a cause owned by this
    // CLI; the state add-on adds no common cause (WIRE-19; K1-10).
    if (cause === undefined || Object.hasOwn(commonCauses, cause))
      throw new Error("Coordination refusal causes are host-owned.");
    const station = command.stations.find((item) => item.causeCode === cause);
    if (
      !station ||
      station.row.outcome !== "refused" ||
      station.row.transactionState !== "unchanged" ||
      !station.guidance.handoff
    )
      throw new Error("Coordination refusal requires an unchanged handoff.");
  }
}
// Host route tokens are checked before collisions so a route that names a
// built-in switch is refused with its own token (F04, CMD-1).
function validateRoutes(
  cli: string,
  commands: readonly CommandDeclaration[],
): void {
  const builtinIdentities = builtins(cli).map((item) => item.commandIdentity);
  for (const command of commands)
    if (!builtinIdentities.includes(command.commandIdentity))
      validateRouteTokens(command.route);
  const hostRoutes = commands
    .filter((item) => item.commandIdentity !== `${cli}.dispatch`)
    .map((item) => JSON.stringify(item.route));
  if (new Set(hostRoutes).size !== hostRoutes.length)
    throw new Error("Duplicate command route.");
}
export function validateCommands(
  cli: string,
  commands: readonly CommandDeclaration[],
  causes: CauseTable,
  installed: readonly AddonName[],
): void {
  if (!text(cli) || new Set(installed).size !== installed.length)
    throw new Error("Invalid CLI identity or add-on manifest.");
  if (
    new Set(commands.map((item) => item.commandIdentity)).size !==
    commands.length
  )
    throw new Error("Duplicate command identity.");
  validateRoutes(cli, commands);
  const builtinIdentities = builtins(cli).map((item) => item.commandIdentity);
  for (const command of commands)
    admitCommand(cli, command, commands, causes, installed, {
      host: !builtinIdentities.includes(command.commandIdentity),
    });
}
// Every admission rule for one declaration, in refusal-priority order.
function admitCommand(
  cli: string,
  command: CommandDeclaration,
  commands: readonly CommandDeclaration[],
  causes: CauseTable,
  installed: readonly AddonName[],
  { host }: { readonly host: boolean },
): void {
  // K1-5: a raw declaration meets the same shape rules as a constructed one.
  if (host)
    if (command.effectClass === "inspect") admitInspectShape(command);
    else admitChangingShape(command);
  validateCommandIdentity(command.commandIdentity);
  validateHostInput(command.input);
  if (command.commandIdentity !== `${cli}.dispatch`)
    validateRootOperation(command.route, command.input);
  for (const name of Object.keys(command.capabilities))
    if (!installed.some((entry) => entry === name))
      throw new Error("Declared capability add-on is not installed.");
  if (command.effectClass !== "inspect" && !installed.includes("state"))
    throw new Error("Changing commands require the state add-on.");
  validateStationSet(command, causes);
  validateIfNoResult(command, commands);
  validateGuidance(command, commands);
  validateStepVectors(cli, command, commands);
  // Last, so a more specific refusal of the same declaration wins.
  if (host && typeof command.execute !== "function")
    throw new Error("Host command needs an executable handler.");
  // CMD-9 steps 5 and 6: only command() and changing() register the
  // two-phase entry that runs the approval guard before any attachment, so
  // a declaration without it may neither declare approval nor change state
  // (delta review F1). A raw read-only declaration stays admitted (K1-5).
  if (
    host &&
    !preparerOf(command) &&
    (command.capabilities.approval === true ||
      command.effectClass !== "inspect")
  )
    throw new Error(
      "A command that declares approval or changes state must be built with command() or changing().",
    );
}
// F01 (option 2): refuse a step template no single-token value can satisfy.
function validateStepVectors(
  cli: string,
  command: CommandDeclaration,
  commands: readonly CommandDeclaration[],
): void {
  for (const { target, args } of guidanceTargets(command, commands)) {
    const problem = target
      ? stepVectorProblem(
          target,
          args,
          target.commandIdentity !== `${cli}.dispatch`,
        )
      : undefined;
    if (target && problem)
      throw new Error(
        `Command step ${target.commandIdentity} ${JSON.stringify(args)} from ${command.commandIdentity} can never parse: ${problem}.`,
      );
  }
}

export type CommandIdentity<D extends readonly CommandDeclaration[]> =
  D[number]["commandIdentity"];
export type InspectIdentity<D extends readonly CommandDeclaration[]> = Extract<
  D[number],
  { readonly effectClass: "inspect" }
>["commandIdentity"];
export type ValidatedCommands<
  D extends readonly CommandDeclaration[],
  Cli extends string,
> = {
  readonly [K in keyof D]: {
    readonly stations: readonly {
      readonly commandIdentity: D[K]["commandIdentity"];
      readonly guidance:
        | {
            readonly next: import("./types.ts").NextStep<
              | CommandIdentity<D>
              | `${Cli}.${"help" | "discovery" | "command-discovery"}`
            >;
          }
        | {
            readonly handoff: import("./types.ts").Handoff<
              | InspectIdentity<D>
              | `${Cli}.${"help" | "discovery" | "command-discovery"}`
            >;
          };
    }[];
  };
};
export type ValidatedStation<D extends readonly CommandDeclaration[]> =
  D[number]["stations"][number];
export type RunFacts<
  S extends import("./stations.ts").DeclaredStation,
  D extends readonly CommandDeclaration[],
> = FactsForRow<
  S["row"],
  Extract<
    D[number],
    { readonly commandIdentity: S["commandIdentity"] }
  >["effectClass"]
>;
export type FactsForRow<
  R extends import("./types.ts").CauseRow,
  E extends import("./types.ts").EffectClass,
> = {
  readonly runId: string;
  readonly message: string;
  readonly data: R["outcome"] extends "success"
    ? import("./types.ts").JsonValue
    : null;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
} & (R extends { readonly retryable: true }
  ? { readonly retryDelayMilliseconds: number }
  : { readonly retryDelayMilliseconds?: never }) &
  (R extends { readonly outcome: "failed" }
    ? { readonly attemptedEffect?: string }
    : { readonly attemptedEffect?: never }) &
  (E extends "inspect"
    ? {
        readonly effects: import("./types.ts").StateEffects<
          "unchanged",
          R["outcome"]
        >;
        readonly transaction?: never;
      }
    : R extends { readonly outcome: "refused" }
      ? {
          readonly effects: import("./types.ts").StateEffects<
            "unchanged",
            "refused"
          >;
          readonly transaction?: never;
        }
      : {
          readonly effects?: never;
          readonly transaction: import("./state-seam.ts").TransactionProof;
        });

function validateGuidance(
  command: CommandDeclaration,
  commands: readonly CommandDeclaration[],
): void {
  for (const { target, inspection } of guidanceTargets(command, commands)) {
    if (!target || (inspection && target.effectClass !== "inspect"))
      throw new Error(
        "Guidance target is not declared with the required effect class.",
      );
  }
  const names = new Set(command.stations.flatMap(bindingNames));
  for (const [binding, source] of Object.entries(
    command.futureBindings ?? {},
  )) {
    if (
      (!names.has(binding) && binding !== "idempotencyKey") ||
      ![...command.input.arguments, ...command.input.options].some(
        (slot) => slot.name === source,
      )
    )
      throw new Error(
        "Future binding needs a declared token and input source.",
      );
  }
}
