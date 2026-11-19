import type { CommandResult } from "./command-result.ts";
import type { CommandDeclaration } from "./declarations.ts";
import type { DeclaredStation } from "./stations.ts";
import type { StateObservation } from "./state-seam.ts";
import type { Effects, Envelope, JsonValue, Validation } from "./types.ts";

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
  readonly prepare: (
    identity: string,
    argv: readonly string[],
    runId: string,
    context: unknown,
  ) => Promise<Validation<Attach>>;
  readonly buildKernelStation: (
    selected: { readonly commandIdentity: string; readonly causeCode: string },
    facts: KernelFacts,
    effects: Effects,
  ) => Promise<Validation<unknown>>;
  readonly buildResult: (result: CommandResult) => Promise<Validation<unknown>>;
  readonly validate: (value: unknown) => Promise<Validation<Envelope>>;
  readonly trustedSummary: (runId: string) => StateObservation | undefined;
  readonly closeStateAtDeadline: (runId: string) => boolean | undefined;
  readonly forgetState: (runId: string) => void;
};

export type ContractKey = { readonly cli?: string };

const runtimes = new WeakMap<ContractKey, ContractRuntime>();

export function recordRuntime(contract: ContractKey, runtime: ContractRuntime) {
  runtimes.set(contract, runtime);
}

export function runtimeOf(contract: ContractKey): ContractRuntime | undefined {
  return runtimes.get(contract);
}
