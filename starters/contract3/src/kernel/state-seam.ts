import type { CommandStep, Effects, TransactionState } from "./types.ts";
import { effects as validEffects } from "./validation/result.ts";
const noResultRoute = Symbol("state.ifNoResult");
const recordedEffect = Symbol("state.recordedEffect");
const transactionProof = Symbol("state.transactionProof");
const exclusiveScope = Symbol("state.exclusiveScope");
export type IfNoResult<Identity extends string = string> = {
  readonly [noResultRoute]: true;
  readonly step: CommandStep<Identity>;
};
export type RecordedEffect<Effect extends string = string> = {
  readonly [recordedEffect]: true;
  readonly runId: string;
  readonly effect: Effect;
  readonly admitStart: <T>(
    runId: string,
    effect: Effect,
    start: () => Promise<T>,
  ) => Promise<T>;
};
export type TransactionProof<Effect extends string = string> = {
  readonly [transactionProof]: true;
  readonly runId: string;
  readonly transactionState: TransactionState;
  readonly effects: Effects & {
    readonly completed: readonly Effect[];
    readonly remaining: readonly Effect[];
    readonly uncertain: readonly Effect[];
  };
};
export type ExclusiveScope = {
  readonly [exclusiveScope]: true;
  readonly runId: string;
  readonly scope: string;
  readonly isActive: () => boolean;
};
export type StateIssuer = {
  readonly ifNoResult: <Identity extends string>(
    step: CommandStep<Identity>,
  ) => IfNoResult<Identity>;
  readonly recordedEffect: <Effect extends string>(
    runId: string,
    effect: Effect,
    admitStart: RecordedEffect<Effect>["admitStart"],
  ) => RecordedEffect<Effect>;
  readonly transactionProof: <Effect extends string>(
    runId: string,
    state: TransactionState,
    effects: TransactionProof<Effect>["effects"],
  ) => TransactionProof<Effect>;
  readonly exclusiveScope: (
    runId: string,
    scope: string,
    isActive: () => boolean,
  ) => ExclusiveScope;
};
const routes = new WeakSet<object>();
const proofs = new WeakSet<object>();
export function knownRoute(value: IfNoResult): boolean {
  return routes.has(value);
}
export function knownProof(value: TransactionProof, runId: string): boolean {
  return proofs.has(value) && value.runId === runId;
}
export function stateIssuer(): StateIssuer {
  return Object.freeze({
    ifNoResult<Identity extends string>(
      step: CommandStep<Identity>,
    ): IfNoResult<Identity> {
      if (
        step.args.length > 16 ||
        step.args.some((arg) => /[{}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(arg)) ||
        new TextEncoder().encode(JSON.stringify(step)).byteLength > 2048
      )
        throw new Error("Invalid ifNoResult literal step.");
      const route = Object.freeze({
        [noResultRoute]: true as const,
        step: Object.freeze({ ...step, args: Object.freeze([...step.args]) }),
      });
      routes.add(route);
      return route;
    },
    recordedEffect<Effect extends string>(
      runId: string,
      effect: Effect,
      admitStart: RecordedEffect<Effect>["admitStart"],
    ): RecordedEffect<Effect> {
      return Object.freeze({
        [recordedEffect]: true as const,
        runId,
        effect,
        admitStart,
      });
    },
    transactionProof<Effect extends string>(
      runId: string,
      transactionState: TransactionState,
      effects: TransactionProof<Effect>["effects"],
    ): TransactionProof<Effect> {
      if (!validEffects(effects))
        throw new Error("Invalid transaction effects.");
      const proof = Object.freeze({
        [transactionProof]: true as const,
        runId,
        transactionState,
        effects: structuredClone(effects),
      });
      proofs.add(proof);
      return proof;
    },
    exclusiveScope(
      runId: string,
      scope: string,
      isActive: () => boolean,
    ): ExclusiveScope {
      return Object.freeze({
        [exclusiveScope]: true as const,
        runId,
        scope,
        isActive,
      });
    },
  });
}
