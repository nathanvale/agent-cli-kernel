import type { JsonValue } from "./types.ts";

declare const authorityIdentity: unique symbol;
declare const resourceIdentity: unique symbol;
declare const parsedPath: unique symbol;
export type AuthorityId = string & { readonly [authorityIdentity]: true };
export type ResourceId = string & { readonly [resourceIdentity]: true };
export type ParsedPath = string & { readonly [parsedPath]: true };
import type {
  RecordedEffect,
  TransactionProof,
  ExclusiveScope,
} from "./state-seam.ts";
export type {
  IfNoResult,
  RecordedEffect,
  TransactionProof,
  StateIssuer,
  ExclusiveScope,
} from "./state-seam.ts";
export type EffectTransaction<Effect extends string> = {
  readonly record: <T>(
    effect: Effect,
    operation: (capability: RecordedEffect<Effect>) => Promise<T>,
    readBack: (result: T) => Promise<boolean>,
  ) => Promise<T>;
};
export type StateCapability<Effect extends string> = {
  readonly transaction: (
    work: (transaction: EffectTransaction<Effect>) => Promise<void>,
  ) => Promise<TransactionProof<Effect>>;
};
export type ProgramRequest = {
  readonly executable: ParsedPath;
  readonly args: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly outputLimitBytes: number;
  readonly shutdownMilliseconds: number;
};
export type ProgramResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly terminationConfirmed: boolean;
  // Interface: True when either captured stream was cut at its declared bound or
  // abandoned, so the handler knows stdout or stderr is incomplete.
  readonly outputTruncated: boolean;
};
export type ProgramHandle<Effect extends string = string> = {
  readonly effect: Effect;
  readonly start: (request: ProgramRequest) => Promise<ProgramResult>;
};
export type ProgramsCapability = {
  readonly inspect: (request: ProgramRequest) => Promise<ProgramResult>;
  readonly supplied: (request: ProgramRequest) => Promise<ProgramResult>;
  readonly domain: <Effect extends string>(
    effect: RecordedEffect<Effect>,
  ) => ProgramHandle<Effect>;
};
export type ApprovalCapability = {
  readonly check: (request: ApprovalRequest) => Promise<boolean>;
};
export type DiagnosticsCapability = {
  readonly record: (event: string, facts: JsonValue) => void;
};
export type CapabilitySelection = {
  readonly programs?: true;
  readonly approval?: true;
  readonly diagnostics?: true;
};
export type HandlerContext<C extends CapabilitySelection> = (C extends {
  programs: true;
}
  ? { readonly programs: ProgramsCapability }
  : object) &
  (C extends { approval: true }
    ? { readonly approval: ApprovalCapability }
    : object) &
  (C extends { diagnostics: true }
    ? { readonly diagnostics: DiagnosticsCapability }
    : object);
// Interface: Every handler context carries its run's stop signal. It aborts at the
// first stop request or at the deadline: start no new work after that. A run
// entered with no stop source holds a signal that never aborts. The
// lifecycle's waits and exits are unchanged (LIFE-6, LIFE-11).
export type StopContext = { readonly signal: AbortSignal };
export type RunProcess = (argv: unknown) => Promise<number>;

export type ApprovalRequest = {
  readonly authority: AuthorityId;
  readonly resource: ResourceId;
  readonly resourceRevision: string;
  readonly effects: readonly string[];
  // Interface: CMD-10b: the unconsumed preview this apply is bound to. An approval
  // add-on refuses a request without it.
  readonly preview?: string;
};
export type ApprovalRuntime = {
  readonly check: (request: ApprovalRequest) => Promise<boolean>;
  readonly revalidateAndConsume: (
    request: ApprovalRequest,
    coordination: ExclusiveScope,
  ) => Promise<{ readonly consumed: boolean }>;
};
