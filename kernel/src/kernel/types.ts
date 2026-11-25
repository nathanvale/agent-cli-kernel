export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type Outcome = "success" | "refused" | "failed";
export type TransactionState =
  | "unchanged"
  | "completed"
  | "partially-completed"
  | "unknown";
export type EffectClass = "inspect" | "repository-local" | "external";
export type FailureClass =
  | "internal"
  | "usage"
  | "domain"
  | "schema"
  | "transient";
export const exits = {
  success: 0,
  internal: 1,
  usage: 2,
  domain: 3,
  schema: 4,
  transient: 75,
} as const satisfies Record<FailureClass | "success", number>;
export type ExitCode = (typeof exits)[keyof typeof exits];
export type FailureExit = {
  [F in Exclude<FailureClass, "transient">]: {
    readonly failureClass: F;
    readonly exitCode: (typeof exits)[F];
  };
}[Exclude<FailureClass, "transient">];
export type AttemptExit = {
  [F in "internal" | "domain" | "schema"]: {
    readonly failureClass: F;
    readonly exitCode: (typeof exits)[F];
  };
}["internal" | "domain" | "schema"];
export type CauseRow =
  | {
      readonly outcome: "success";
      readonly transactionState: "unchanged" | "completed";
      readonly failureClass: null;
      readonly exitCode: 0;
      readonly retryable: false;
      readonly guidance: "next";
    }
  | {
      readonly outcome: "refused";
      readonly transactionState: "unchanged";
      readonly failureClass: "domain";
      readonly exitCode: 3;
      readonly retryable: false;
      readonly guidance: "next" | "handoff";
      readonly carriesData?: never;
    }
  | {
      readonly outcome: "refused";
      readonly transactionState: "unchanged";
      readonly failureClass: "domain";
      readonly exitCode: 3;
      readonly retryable: false;
      readonly guidance: "next" | "handoff";
      readonly carriesData: true;
    }
  | ({
      readonly outcome: "refused";
      readonly transactionState: "unchanged";
      readonly retryable: false;
      readonly guidance: "next" | "handoff";
    } & Exclude<FailureExit, { readonly failureClass: "domain" }>)
  | ({
      readonly outcome: "failed";
      readonly transactionState: "unchanged";
      readonly retryable: false;
      readonly guidance: "next" | "handoff";
    } & AttemptExit)
  | ({
      readonly outcome: "failed";
      readonly transactionState:
        | "completed"
        | "partially-completed"
        | "unknown";
      readonly retryable: false;
      readonly guidance: "handoff";
    } & AttemptExit)
  | {
      readonly outcome: "refused" | "failed";
      readonly transactionState: "unchanged";
      readonly failureClass: "transient";
      readonly exitCode: 75;
      readonly retryable: true;
      readonly guidance: "next";
    };
export type CauseTable = Readonly<Record<string, CauseRow>>;
export type CommandStep<Identity extends string = string> = {
  readonly kind: "command";
  readonly command: Identity;
  readonly args: readonly string[];
};
export type InstructionStep = {
  readonly kind: "instruction";
  readonly text: string;
};
export type NextStep<Identity extends string = string> =
  | CommandStep<Identity>
  | InstructionStep
  | { readonly kind: "retry" }
  | { readonly kind: "done" };
export type Handoff<InspectIdentity extends string = string> = {
  readonly owner: "human" | "operator";
  readonly reason: string;
  readonly inspect: readonly [
    CommandStep<InspectIdentity> | InstructionStep,
    ...(CommandStep<InspectIdentity> | InstructionStep)[],
  ];
  readonly resource?: { readonly kind: string; readonly id: string };
};
export type Effects = {
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  readonly uncertain: readonly string[];
  readonly inventoryComplete: boolean;
};
export type Nonempty = readonly [string, ...string[]];
export type StateEffects<
  S extends TransactionState,
  O extends Outcome,
> = S extends "unchanged"
  ? {
      readonly completed: readonly [];
      readonly remaining: O extends "success" ? readonly [] : readonly string[];
      readonly uncertain: readonly [];
      readonly inventoryComplete: true;
    }
  : S extends "completed"
    ? {
        readonly completed: Nonempty;
        readonly remaining: readonly [];
        readonly uncertain: readonly [];
        readonly inventoryComplete: true;
      }
    : S extends "partially-completed"
      ? {
          readonly completed: Nonempty;
          readonly remaining: Nonempty;
          readonly uncertain: readonly [];
          readonly inventoryComplete: true;
        }
      :
          | {
              readonly completed: readonly string[];
              readonly remaining: readonly string[];
              readonly uncertain: Nonempty;
              readonly inventoryComplete: true;
            }
          | {
              readonly completed: readonly string[];
              readonly remaining: readonly string[];
              readonly uncertain: readonly string[];
              readonly inventoryComplete: false;
            };
export type RowGuidance<
  R extends CauseRow,
  Identity extends string = string,
  InspectIdentity extends string = string,
> = R extends { guidance: "handoff" }
  ? { readonly handoff: Handoff<InspectIdentity>; readonly next?: never }
  : {
      readonly next: R extends { retryable: true }
        ? { readonly kind: "retry" }
        : R extends { outcome: "success" }
          ? Exclude<NextStep<Identity>, { kind: "retry" }>
          : CommandStep<Identity> | InstructionStep;
      readonly handoff?: never;
    };
export type RowResult<
  R extends CauseRow,
  K extends string,
  Identity extends string,
  InspectIdentity extends string,
> = R extends CauseRow
  ? StateResult<R, R["transactionState"], K, Identity, InspectIdentity>
  : never;
export type StateResult<
  R extends CauseRow,
  S extends TransactionState,
  K extends string,
  Identity extends string,
  InspectIdentity extends string,
> = S extends TransactionState
  ? Omit<R, "guidance" | "transactionState" | "carriesData"> & {
      readonly transactionState: S;
      readonly runId: string;
      readonly commandIdentity: Identity;
      readonly causeCode: K;
      readonly data: R["outcome"] extends "success"
        ? JsonValue
        : R extends { readonly carriesData: true }
          ? JsonValue
          : null;
      readonly repairAction: R["outcome"] extends "success" ? null : string;
      readonly bindings?: Readonly<Record<string, string>>;
      readonly idempotencyKey?: string;
      readonly superseded?: readonly string[];
    } & RowGuidance<R, Identity, InspectIdentity> &
      (R extends { retryable: true }
        ? { readonly retryDelayMilliseconds: number }
        : { readonly retryDelayMilliseconds?: never }) &
      (R extends { outcome: "failed" }
        ? { readonly attemptedEffect?: string }
        : { readonly attemptedEffect?: never }) &
      (S extends "unchanged"
        ? {
            readonly effectClass: EffectClass;
            readonly effects: StateEffects<"unchanged", R["outcome"]>;
          }
        : {
            readonly effectClass: Exclude<EffectClass, "inspect">;
            readonly effects: StateEffects<S, R["outcome"]>;
          })
  : never;
export type ResultFor<
  C extends CauseTable,
  Identity extends string = string,
  InspectIdentity extends string = string,
> = {
  [K in keyof C & string]: RowResult<C[K], K, Identity, InspectIdentity>;
}[keyof C & string];
export type WireResult = {
  readonly runId: string;
  readonly commandIdentity: string;
  readonly outcome: Outcome;
  readonly effectClass: EffectClass;
  readonly transactionState: TransactionState;
  readonly causeCode: string;
  readonly failureClass: FailureClass | null;
  readonly exitCode: ExitCode;
  readonly data: JsonValue;
  readonly retryable: boolean;
  readonly retryDelayMilliseconds?: number;
  readonly repairAction: string | null;
  readonly effects: Effects;
  readonly next?: NextStep;
  readonly handoff?: Handoff;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly attemptedEffect?: string;
  readonly superseded?: readonly string[];
};
export type DiagnosticFacts = {
  readonly file: string | null;
  readonly sinkFailure:
    | null
    | "capacity"
    | "setup"
    | "write"
    | "flush-timeout"
    | "close";
  readonly droppedRecords: number;
  readonly unflushedRecords: number;
  readonly truncatedRecords: number;
  readonly countsComplete: boolean;
  readonly closed: boolean;
};
export type Diagnostics =
  | ({ readonly status: "available" } & DiagnosticFacts)
  | {
      readonly status: "unavailable";
      readonly reason: "status-invalid" | "status-unavailable";
      readonly trusted: Partial<DiagnosticFacts>;
    };
export type Envelope<R = WireResult> = {
  readonly contractVersion: string;
  readonly message: string;
  readonly availablePaths: readonly string[];
  readonly result: R;
  readonly diagnostics?: Diagnostics;
};
export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly path: string; readonly reason: string };
