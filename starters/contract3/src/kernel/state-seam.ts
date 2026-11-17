import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandStep, StateEffects, TransactionState } from "./types.ts";
import {
  effects as validEffects,
  transactionEffects,
} from "./validation/result.ts";
const ifNoResultStep = Symbol("state.ifNoResult");
const recordedEffect = Symbol("state.recordedEffect");
const transactionProof = Symbol("state.transactionProof");
const exclusiveScope = Symbol("state.exclusiveScope");
export type IfNoResult<Identity extends string = string> = {
  readonly [ifNoResultStep]: true;
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
  // Issues a scope only for a run this state add-on instance has attached; it throws
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
  proof: TransactionProof | undefined;
  // Why the capability refuses new work: the handler returned, or the
  // deadline passed (LIFE-6; K2-spec-3).
  closed: "returned" | "deadline" | undefined;
};
const closedReason = {
  returned: "The state capability closed when the handler returned.",
  deadline: "The state capability closed at the deadline.",
} as const;
// LIFE-6: at the deadline the run starts no transaction and records no
// effect. Returns whether a transaction had started on the run's current
// attachment, or undefined when the run has none.
export function closeAtDeadline(
  runId: string,
  descriptor: StateAddonDescriptor | undefined,
): boolean | undefined {
  const run = descriptor
    ? registrations.get(descriptor)?.runs.get(runId)
    : undefined;
  const status = run ? attachedRuns.get(run) : undefined;
  if (!status) return undefined;
  status.closed ??= "deadline";
  return status.transactionStarted;
}
const attachedRuns = new WeakMap<object, AttachedRun>();
type IssuedScope = {
  readonly runId: string;
  readonly stateInstance: object;
  readonly run: object;
  readonly isActive: () => boolean;
};
const scopes = new WeakMap<object, IssuedScope>();
const proofs = new WeakMap<
  object,
  {
    readonly runId: string;
    readonly stateInstance: object;
    readonly run: object;
  }
>();
export function isIssuedIfNoResult(value: IfNoResult): boolean {
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
    registration?.stateInstance === proof.stateInstance &&
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
  return (
    !attached?.transactionStarted ||
    attached.proof?.transactionState === "unchanged"
  );
}
// Accepted decision (contract question 4 of 8): the trusted summary is any
// proof this state add-on instance issued for the run's current attachment,
// whether or not the handler returned.
export function issuedProof(
  runId: string,
  descriptor: StateAddonDescriptor | undefined,
): TransactionProof | undefined {
  const run = descriptor
    ? registrations.get(descriptor)?.runs.get(runId)
    : undefined;
  return run ? attachedRuns.get(run)?.proof : undefined;
}
// Runtime counterpart of the ExclusiveScope brand (K2): true only for the
// kernel-issued object itself, issued by `descriptor`'s state add-on instance for the
// run's current attachment, while isActive() returns true (a throw is false).
// The descriptor is required so a scope from another state add-on instance for the
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
    registration.stateInstance !== issued.stateInstance ||
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
  stateInstance: object,
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
        [ifNoResultStep]: true as const,
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
      // Each effect is refused before its operation once the run's
      // capability has closed (LIFE-6; K2-spec-3): an installer issues
      // the recorded effect before it runs the operation.
      const run = runs.get(runId);
      const closed = run ? attachedRuns.get(run)?.closed : undefined;
      if (closed) throw new Error(closedReason[closed]);
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
      if (!attached || attached.proof !== undefined)
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
      proofs.set(proof, { runId, stateInstance, run });
      attached.proof = proof;
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
      scopes.set(issued, { runId, stateInstance, run, isActive });
      return issued;
    },
  });
}

const stateAddonDescriptor = Symbol("state.addonDescriptor");
export type StateFactoryResult = {
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
    readonly registration: StateFactoryResult;
    readonly stateInstance: object;
    readonly runs: Map<string, object>;
    // Every run identity this state add-on instance has claimed (WIRE-7).
    readonly used: Set<string>;
    readonly active: AsyncLocalStorage<{
      readonly runId: string;
      readonly run: object;
    }>;
  }
>();
export function createStateAddon(
  install: (issuer: StateIssuer) => StateFactoryResult,
): StateAddonDescriptor {
  const stateInstance = Object.freeze({});
  const runs = new Map<string, object>();
  const active = new AsyncLocalStorage<{
    readonly runId: string;
    readonly run: object;
  }>();
  const registration = install(stateIssuer(stateInstance, active, runs));
  if (!isIssuedIfNoResult(registration.ifNoResult))
    throw new Error(
      "The state add-on factory did not provide an issued ifNoResult step.",
    );
  const descriptor = Object.freeze({
    [stateAddonDescriptor]: true as const,
    ifNoResult: registration.ifNoResult,
  });
  registrations.set(descriptor, {
    registration,
    stateInstance,
    runs,
    active,
    used: new Set(),
  });
  return descriptor;
}
export function isStateDescriptor(descriptor: object): boolean {
  return registrations.has(descriptor);
}

export function attachState<Effect extends string>(
  descriptor: StateAddonDescriptor,
  runId: string,
  effects: readonly Effect[],
):
  | {
      readonly capability: import("./capabilities.ts").StateCapability<Effect>;
      readonly close: () => void;
    }
  | undefined {
  const state = registrations.get(descriptor);
  if (!state)
    throw new Error(
      "State descriptor was not created by contractFor.stateAddon.",
    );
  // WIRE-7: a run identity is unique. Claiming it and attaching happen here
  // together, at handler entry (CMD-9 step 6; delta review F2). A used
  // identity stays used: the reuse is refused (undefined) and the earlier
  // attachment is superseded, so no proof or scope of that identity stands
  // (K2-spec-2, repair 1 B2).
  if (state.used.has(runId)) {
    state.runs.delete(runId);
    return undefined;
  }
  state.used.add(runId);
  const run = Object.freeze({});
  const status: AttachedRun = {
    transactionStarted: false,
    proof: undefined,
    closed: undefined,
  };
  attachedRuns.set(run, status);
  state.runs.set(runId, run);
  const attached = state.registration.attach(runId, effects);
  const capability: import("./capabilities.ts").StateCapability<Effect> =
    Object.freeze({
      transaction(work) {
        // Refused once the handler has returned (its result already exists,
        // and a refusal must precede any attempted change, WIRE-15) or the
        // deadline has passed (LIFE-6).
        if (status.closed)
          return Promise.reject(new Error(closedReason[status.closed]));
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
      status.closed ??= "returned";
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
