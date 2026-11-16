import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandStep, StateEffects, TransactionState } from "./types.ts";
import {
  effects as validEffects,
  transactionEffects,
} from "./validation/result.ts";
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
export type StateObservation<Effect extends string = string> = {
  [State in TransactionState]: {
    readonly transactionState: State;
    readonly effects: StateEffects<State, "failed"> & {
      readonly completed: readonly Effect[];
      readonly remaining: readonly Effect[];
      readonly uncertain: readonly Effect[];
    };
  };
}[TransactionState];
export type TransactionProof<Effect extends string = string> =
  StateObservation<Effect> & {
    readonly [transactionProof]: true;
    readonly runId: string;
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
    observation: StateObservation<Effect>,
  ) => TransactionProof<Effect>;
  // Issues a scope only for a run this installation has attached; it throws
  // otherwise. A production scope is always acquired for an attached run before
  // the approved effect (CMD-9 step 7), so an unattached run fails early.
  readonly exclusiveScope: (
    runId: string,
    scope: string,
    isActive: () => boolean,
  ) => ExclusiveScope;
};
const routes = new WeakSet<object>();
// One attachment allows one transaction and one proof (F13). An earlier proof
// can therefore never stand in for a later transaction on the same attachment.
type AttachedRun = {
  transactionStarted: boolean;
  proofState: TransactionState | undefined;
};
const attachedRuns = new WeakMap<object, AttachedRun>();
type IssuedScope = {
  readonly runId: string;
  readonly installation: object;
  readonly run: object;
  readonly isActive: () => boolean;
};
const scopes = new WeakMap<object, IssuedScope>();
const proofs = new WeakMap<
  object,
  {
    readonly runId: string;
    readonly installation: object;
    readonly run: object;
  }
>();
export function knownRoute(value: IfNoResult): boolean {
  return routes.has(value);
}
export function knownProof(
  value: object,
  runId: string,
  descriptor: StateAddonDescriptor | undefined,
): boolean {
  const proof = proofs.get(value);
  const registration = descriptor ? registrations.get(descriptor) : undefined;
  return (
    proof !== undefined &&
    proof.runId === runId &&
    registration?.installation === proof.installation &&
    registration.runs.get(runId) === proof.run
  );
}
// A changing result without a proof (a refusal) may follow no transaction, or
// only one whose proof reports `unchanged`; anything else would hide effects.
export function proofFreeResultAllowed(
  runId: string,
  descriptor: StateAddonDescriptor | undefined,
): boolean {
  const run = descriptor
    ? registrations.get(descriptor)?.runs.get(runId)
    : undefined;
  const attached = run ? attachedRuns.get(run) : undefined;
  return !attached?.transactionStarted || attached.proofState === "unchanged";
}
// Runtime counterpart of the ExclusiveScope brand (K2): true only for the
// kernel-issued object itself, issued by `descriptor`'s installation for the
// run's current attachment, while isActive() returns true (a throw is false).
// The descriptor is required so a scope from another installation for the
// same run can never pass.
export function issuedScope(
  value: unknown,
  runId: string,
  descriptor: StateAddonDescriptor,
): boolean {
  const issued =
    typeof value === "object" && value !== null ? scopes.get(value) : undefined;
  const registration = registrations.get(descriptor);
  if (
    !issued ||
    !registration ||
    issued.runId !== runId ||
    registration.installation !== issued.installation ||
    registration.runs.get(runId) !== issued.run
  )
    return false;
  try {
    return issued.isActive() === true;
  } catch {
    return false;
  }
}
function stateIssuer(
  installation: object,
  active: AsyncLocalStorage<{ readonly runId: string; readonly run: object }>,
  runs: ReadonlyMap<string, object>,
): StateIssuer {
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
      observation: StateObservation<Effect>,
    ): TransactionProof<Effect> {
      // Read the installer's observation exactly once; the proof is built
      // from the same plain copy that was validated, so an accessor cannot
      // report one state to the check and another to the proof (K2-spec-1).
      const snapshot = structuredClone(observation);
      if (
        !validEffects(snapshot.effects) ||
        !transactionEffects(
          snapshot.transactionState,
          snapshot.effects,
          "failed",
        )
      )
        throw new Error("Invalid transaction effects.");
      const execution = active.getStore();
      if (!execution || execution.runId !== runId)
        throw new Error("Transaction proof requires the active attached run.");
      const run = execution.run;
      const attached = attachedRuns.get(run);
      if (!attached || attached.proofState !== undefined)
        throw new Error("One transaction proof per attached run.");
      const proof: TransactionProof<Effect> = {
        ...snapshot,
        [transactionProof]: true,
        runId,
      };
      Object.freeze(proof.effects.completed);
      Object.freeze(proof.effects.remaining);
      Object.freeze(proof.effects.uncertain);
      Object.freeze(proof.effects);
      Object.freeze(proof);
      proofs.set(proof, { runId, installation, run });
      attached.proofState = proof.transactionState;
      return proof;
    },
    exclusiveScope(
      runId: string,
      scope: string,
      isActive: () => boolean,
    ): ExclusiveScope {
      const run = runs.get(runId);
      if (!run) throw new Error("Exclusive scope requires the attached run.");
      const issued = Object.freeze({
        [exclusiveScope]: true as const,
        runId,
        scope,
        isActive,
      });
      scopes.set(issued, { runId, installation, run, isActive });
      return issued;
    },
  });
}

const stateAddonDescriptor = Symbol("state.addonDescriptor");
export type StateRegistration = {
  readonly ifNoResult: IfNoResult;
  readonly attach: <Effect extends string>(
    runId: string,
    effects: readonly Effect[],
  ) => import("./capabilities.ts").StateCapability<Effect>;
};
export type StateAddonDescriptor = {
  readonly [stateAddonDescriptor]: true;
  readonly ifNoResult: IfNoResult;
};
const registrations = new WeakMap<
  object,
  {
    readonly registration: StateRegistration;
    readonly installation: object;
    readonly runs: Map<string, object>;
    readonly active: AsyncLocalStorage<{
      readonly runId: string;
      readonly run: object;
    }>;
  }
>();
export function createStateAddon(
  install: (issuer: StateIssuer) => StateRegistration,
): StateAddonDescriptor {
  const installation = Object.freeze({});
  const runs = new Map<string, object>();
  const active = new AsyncLocalStorage<{
    readonly runId: string;
    readonly run: object;
  }>();
  const registration = install(stateIssuer(installation, active, runs));
  if (!knownRoute(registration.ifNoResult))
    throw new Error(
      "State installer did not provide an issued recovery route.",
    );
  const descriptor = Object.freeze({
    [stateAddonDescriptor]: true as const,
    ifNoResult: registration.ifNoResult,
  });
  registrations.set(descriptor, { registration, installation, runs, active });
  return descriptor;
}
export function admittedState(descriptor: object): boolean {
  return registrations.has(descriptor);
}

// WIRE-7: a run identity is unique. A second attachment of one runId to an
// installation is refused, and the earlier attachment is superseded, so no
// proof or scope from either execution stands for that identity
// (K2-spec-2). True when the run identity is fresh for this installation.
export function claimRun(
  descriptor: StateAddonDescriptor,
  runId: string,
): boolean {
  const state = registrations.get(descriptor);
  if (!state) return false;
  if (!state.runs.has(runId)) return true;
  state.runs.delete(runId);
  return false;
}
export function attachState<Effect extends string>(
  descriptor: StateAddonDescriptor,
  runId: string,
  effects: readonly Effect[],
): {
  readonly capability: import("./capabilities.ts").StateCapability<Effect>;
  readonly close: () => void;
} {
  const state = registrations.get(descriptor);
  if (!state) throw new Error("Unadmitted state descriptor.");
  let open = true;
  const run = Object.freeze({});
  const status: AttachedRun = {
    transactionStarted: false,
    proofState: undefined,
  };
  attachedRuns.set(run, status);
  state.runs.set(runId, run);
  const attached = state.registration.attach(runId, effects);
  const capability: import("./capabilities.ts").StateCapability<Effect> =
    Object.freeze({
      transaction(work) {
        // Refused once the handler has returned: its result already exists,
        // and a refusal must precede any attempted change (WIRE-15).
        if (!open)
          return Promise.reject(
            new Error("The state capability closed when the handler returned."),
          );
        // Refused before the work starts, so overlapping and later calls
        // cannot complete an effect the first proof does not report.
        if (status.transactionStarted)
          return Promise.reject(new Error("One transaction per attached run."));
        status.transactionStarted = true;
        return state.active.run({ runId, run }, () =>
          attached.transaction(work),
        );
      },
    });
  capabilities.set(capability, [...effects]);
  return {
    capability,
    close: () => {
      open = false;
    },
  };
}

const capabilities = new WeakMap<object, readonly string[]>();
export function knownCapability(
  value: object,
  effects: readonly string[],
): boolean {
  const registered = capabilities.get(value);
  return (
    registered !== undefined &&
    registered.length === effects.length &&
    registered.every((effect, index) => effect === effects[index])
  );
}
