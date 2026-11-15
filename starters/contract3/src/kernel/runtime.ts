import type { CommandResult } from "./command-result.ts";
import type { CommandDeclaration } from "./declarations.ts";
import type { DeclaredStation } from "./stations.ts";
import type { StateObservation } from "./state-seam.ts";
import type { Effects, Envelope, JsonValue, Validation } from "./types.ts";

// The kernel's private view of one composed contract. The process front door
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
  // Builds a kernel-selected station. `trusted` effects replace a handler's
  // transaction proof and come only from the kernel's own observation.
  readonly build: (
    selected: { readonly commandIdentity: string; readonly causeCode: string },
    facts: KernelFacts,
    trusted: Effects,
  ) => Promise<Validation<unknown>>;
  readonly buildResult: (result: CommandResult) => Promise<Validation<unknown>>;
  readonly validate: (value: unknown) => Promise<Validation<Envelope>>;
  readonly trustedSummary: (
    result: CommandResult,
    runId: string,
  ) => StateObservation | undefined;
};

const runtimes = new WeakMap<object, ContractRuntime>();

export function registerRuntime(contract: object, runtime: ContractRuntime) {
  runtimes.set(contract, runtime);
}

export function runtimeOf(contract: object): ContractRuntime | undefined {
  return runtimes.get(contract);
}
