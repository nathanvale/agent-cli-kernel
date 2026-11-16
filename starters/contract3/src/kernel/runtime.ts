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
  // The same execution in its two CMD-9 phases: steps 3 to 5 (input, future
  // bindings, approval guard) attach nothing; the returned entry attaches
  // state and runs the handler (step 6). execute is prepare then entry.
  readonly prepare: (
    identity: string,
    argv: readonly string[],
    runId: string,
    context: unknown,
  ) => Promise<Validation<() => Promise<Validation<CommandResult>>>>;
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
  readonly trustedSummary: (
    result: CommandResult,
    runId: string,
  ) => StateObservation | undefined;
};

const runtimes = new WeakMap<object, ContractRuntime>();

export function recordRuntime(contract: object, runtime: ContractRuntime) {
  runtimes.set(contract, runtime);
}

export function runtimeOf(contract: object): ContractRuntime | undefined {
  return runtimes.get(contract);
}
