import type { CommandDeclaration } from "./declarations.ts";
import type { DeclaredStation } from "./stations.ts";
import { hostKernelCauses } from "./navigation.ts";
import { freeze, reservedFallbackCause } from "./stations.ts";
import type { Validation, EffectClass } from "./types.ts";
import type { FactsForRow } from "./declaration-checks.ts";
import { commonCauses } from "./causes.ts";
const resultIdentity = Symbol("kernel.commandResult");
export type CommandResult<Identity extends string = string> = {
  readonly commandIdentity: Identity;
  readonly [resultIdentity]: true;
};
// Accepted decision (contract question 7 of 8): the stations that mean
// "refused before the handler started" belong to the base alone. Declaring
// one for its words (DISC-11b) grants a handler no selection (provisional
// reading N5 (a)).
export type PreEntryCause =
  | "USAGE_INVALID_INVOCATION"
  | "DOMAIN_DEADLINE_BEFORE_START";
export type AllowedCause<S extends readonly DeclaredStation[]> =
  | Exclude<S[number]["causeCode"], PreEntryCause>
  | (S[number] extends never ? "SUCCESS_UNCHANGED" : never);
// The runtime counterpart. The approval check's denial is pre-entry too,
// except on a command that declares approval, whose handler reports the
// denial at revalidation under coordination (CMD-9 step 7; provisional
// reading N6 (a)).
function preEntryCause(
  command: CommandDeclaration,
  causeCode: string,
): boolean {
  return (
    causeCode === "USAGE_INVALID_INVOCATION" ||
    causeCode === "DOMAIN_DEADLINE_BEFORE_START" ||
    (causeCode === "DOMAIN_AUTHORITY_REQUIRED" &&
      command.capabilities.approval !== true)
  );
}
export type SelectedRow<
  S extends readonly DeclaredStation[],
  K extends string,
> =
  Extract<S[number], { readonly causeCode: K }> extends never
    ? typeof commonCauses.SUCCESS_UNCHANGED
    : Extract<S[number], { readonly causeCode: K }>["row"];
export type ResultContext<
  Identity extends string,
  S extends readonly DeclaredStation[],
  E extends EffectClass,
> = {
  readonly result: <const K extends AllowedCause<S>>(
    selected: { readonly commandIdentity: Identity; readonly causeCode: K },
    facts: Omit<FactsForRow<SelectedRow<S, K>, E>, "runId">,
  ) => CommandResult<Identity>;
};
export type ResultPlan = {
  readonly selected: {
    readonly commandIdentity: string;
    readonly causeCode: string;
  };
  readonly facts: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly invocation: object;
};
const results = new WeakMap<object, ResultPlan>();
export function resultContext<
  const Identity extends string,
  const S extends readonly DeclaredStation[],
  E extends EffectClass,
>(
  command: CommandDeclaration<Identity> & {
    readonly stations: S;
    readonly effectClass: E;
  },
  runId: string,
  invocation: object,
): ResultContext<Identity, S, E> {
  return {
    result(selected, facts) {
      const declared = command.stations.some(
        (station) => station.causeCode === selected.causeCode,
      );
      // DISC-11b: a handler may select a station the base adds, except the
      // ones the fallback reserves (K1-6) and the pre-entry ones.
      const baseAdded =
        !reservedFallbackCause(selected.causeCode) &&
        hostKernelCauses(command).includes(selected.causeCode);
      if (
        selected.commandIdentity !== command.commandIdentity ||
        (!declared && !baseAdded)
      )
        throw new Error(
          "Result station belongs to another command or is undeclared.",
        );
      if (preEntryCause(command, selected.causeCode))
        throw new Error(
          "A handler never selects a result that belongs before handler entry.",
        );
      const result: CommandResult<Identity> = Object.freeze({
        [resultIdentity]: true as const,
        commandIdentity: command.commandIdentity,
      });
      results.set(result, {
        selected: Object.freeze({ ...selected }),
        facts: freeze({ ...facts, runId }),
        runId,
        invocation,
      });
      return result;
    },
  };
}
export function resultPlan(value: object): ResultPlan | undefined {
  return results.get(value);
}
export function resultMatches(
  value: object,
  identity: string,
  runId: string,
  invocation: object,
): boolean {
  const plan = results.get(value);
  return (
    plan !== undefined &&
    plan.selected.commandIdentity === identity &&
    plan.runId === runId &&
    plan.invocation === invocation
  );
}

export function checkedResult<I extends string>(
  value: CommandResult<I>,
  identity: I,
  runId: string,
  invocation: object,
): Validation<CommandResult<I>> {
  return resultMatches(value, identity, runId, invocation)
    ? { ok: true, value }
    : {
        ok: false,
        path: "result",
        reason: "result belongs to another invocation",
      };
}
