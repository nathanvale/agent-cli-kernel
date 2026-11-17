import type { CommandResult } from "./command-result.ts";
import type { CommandDeclaration } from "./declarations.ts";
import type { DeclaredStation } from "./stations.ts";
import type { StateObservation } from "./state-seam.ts";
import type { Effects, Envelope, JsonValue, Validation } from "./types.ts";

// The kernel's private view of one built contract. The kernel process entry
// reads it; host code only ever holds the opaque contract object.
export type Resolution =
  | {
      readonly ok: false;
      readonly commandIdentity: string;
      readonly causeCode: "USAGE_INVALID_INVOCATION" | "USAGE_UNKNOWN_COMMAND";
      readonly machine: boolean;
    }
  | {
      readonly ok: true;
      readonly value: {
        readonly commandIdentity: string;
        readonly machine: boolean;
        readonly input: Readonly<Record<string, unknown>>;
        readonly args: readonly string[];
        readonly deadlineMilliseconds?: number;
      };
    };

// Handler entry: runs the handler once and validates what it returned.
export type Enter = () => Promise<Validation<CommandResult>>;
// CMD-9 step 6 before handler entry. Called at most once; a throw is a
// preparation fault (accepted decision, contract question 3 of 8).
export type Attach = () => Validation<Enter>;

export type KernelFacts = {
  readonly runId: string;
  readonly message: string;
  readonly data: JsonValue;
};

export type ContractRuntime = {
  readonly cli: string;
  readonly commands: readonly CommandDeclaration[];
  readonly stations: ReadonlyMap<string, readonly DeclaredStation[]>;
  readonly resolve: (argv: unknown) => Promise<Resolution>;
  readonly navigation: {
    readonly help: () => JsonValue;
    readonly discover: () => JsonValue;
    readonly discoverCommand: (identity: string) => JsonValue | undefined;
  };
  readonly execute: (
    identity: string,
    argv: readonly string[],
    runId: string,
    context: unknown,
  ) => Promise<Validation<CommandResult>>;
  // The same execution in its CMD-9 phases: steps 3 to 5 (input, future
  // bindings, approval guard) attach nothing; the returned attach claims the
  // run identity and attaches state (step 6, before handler entry; it may
  // throw); its entry runs the handler. execute is prepare, attach, entry.
  readonly prepare: (
    identity: string,
    argv: readonly string[],
    runId: string,
    context: unknown,
  ) => Promise<Validation<Attach>>;
  // Builds a kernel-selected station with effects from the kernel's own
  // observation. Handler results never reach it: they go through buildResult
  // and the state-issued proof rule.
  readonly buildKernelStation: (
    selected: { readonly commandIdentity: string; readonly causeCode: string },
    facts: KernelFacts,
    effects: Effects,
  ) => Promise<Validation<unknown>>;
  readonly buildResult: (result: CommandResult) => Promise<Validation<unknown>>;
  readonly validate: (value: unknown) => Promise<Validation<Envelope>>;
  // The trusted summary: the proof the state seam issued for the run, if
  // any, whether or not the handler returned (contract question 4 of 8).
  readonly trustedSummary: (runId: string) => StateObservation | undefined;
  // LIFE-6: closes the run's state capability at the deadline; true when a
  // transaction had started, undefined when the run has no state.
  readonly closeStateAtDeadline: (runId: string) => boolean | undefined;
};

const runtimes = new WeakMap<object, ContractRuntime>();

export function recordRuntime(contract: object, runtime: ContractRuntime) {
  runtimes.set(contract, runtime);
}

export function runtimeOf(contract: object): ContractRuntime | undefined {
  return runtimes.get(contract);
}
