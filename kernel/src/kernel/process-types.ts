import type { CapabilitySelection, HandlerContext } from "./capabilities.ts";
import type { Envelope } from "./types.ts";
import type { CapabilityAddonName } from "./validation/context.ts";

export type StopSignal = "SIGINT" | "SIGTERM";

export type ProcessHost = {
  readonly write: (
    stream: "stdout" | "stderr",
    bytes: Uint8Array,
  ) => Promise<boolean>;
  readonly exit: (code: number) => void;
  readonly onSignal: (listener: (signal: StopSignal) => void) => void;
  readonly onCrash: (listener: (error: unknown) => void) => void;
  readonly now: () => number;
};

// Interface: What an add-on learns about the run it serves. `signal` aborts at the first
// stop request or at the deadline: no new work may start after that.
export type RunControl = {
  readonly runId: string;
  readonly commandIdentity: string;
  readonly summary: string;
  readonly signal: AbortSignal;
};

export type AttachedAddon<Capability> = {
  readonly capability: Capability;
  // Interface: Bounded shutdown of owned resources. `limitMilliseconds` caps every
  // declared budget. Resolves true only when every owned resource was observed
  // stopped; an attempt is never reported as termination.
  readonly settle: (limitMilliseconds?: number) => Promise<boolean>;
  // Interface: Synchronous forced termination attempt with no waiting.
  readonly killNow: () => void;
  // Interface: Status seam (LIFE-7 step 1, DIAG-14). Offered only by an add-on whose
  // RunAddon sets `reportsStatus`. Called at most once, after the domain
  // result and recovery are frozen, with the flush budget (500 ms). Resolves
  // the raw diagnostics status; the kernel treats it as untrusted, bounds the
  // wait itself and validates the value alone. On this path it replaces
  // `settle`: the add-on is not counted as an owned program.
  readonly freeze?: (limitMilliseconds: number) => Promise<unknown>;
};

export type RunAddon<Capability> = {
  readonly attach: (run: RunControl) => AttachedAddon<Capability>;
  // Interface: A status-reporting add-on attaches when its declaring command reaches
  // handler entry, before the handler runs, so a status exists even when the handler
  // never uses it. Its attach must be effect-free. At most one per command.
  readonly reportsStatus?: true;
};

export type EmergencyFacts = {
  readonly runId: string;
  readonly commandIdentity: string | null;
  readonly phase: "preparing" | "handler-entered" | "emitting" | "drained";
};

// Interface: What one in-process run returns instead of writing it. `envelope` is the
// one validated envelope machine mode would write, `no-envelope` is a run whose
// fallback also failed, and `stopped` is a run a stop signal ended or a call
// made after one, which never ran. A run that fails inside the kernel rejects
// instead, after it is aborted and its owned programs and emergency record are
// attempted.
export type InProcessResult =
  | {
      readonly kind: "envelope";
      readonly runId: string;
      readonly exitCode: number;
      readonly envelope: Envelope;
    }
  | {
      readonly kind: "no-envelope";
      readonly runId: string;
      readonly exitCode: 1;
    }
  | {
      readonly kind: "stopped";
      readonly runId: string;
      readonly signal: StopSignal;
    };
export type RunInProcess = (argv: unknown) => Promise<InProcessResult>;

export type CapabilityFor = HandlerContext<Required<CapabilitySelection>>;
export type RunSetup = {
  readonly addons?: {
    readonly [K in CapabilityAddonName]?: RunAddon<CapabilityFor[K]>;
  };
  // Interface: At most one bounded synchronous recording attempt on a catchable crash
  // (LIFE-6a). The state add-on supplies it; without one nothing is written.
  readonly emergencyRecord?: (facts: EmergencyFacts) => void;
};

// Interface: Accepted decision (Nathan, 19 November 2026, 12:15 and 13:57
// AEDT): after an uncaught error the kernel stops every run's owned programs
// and writes its emergency records, then calls `onCrash` once with the error,
// then exits 1 as soon as the listener settles or 450 ms after the call. A
// throw or rejection changes nothing, a second crash during the wait exits at
// once, and the kernel prints nothing. An entry's listener is heard from its
// first call on; each entry's listener is called once.
export type InProcessSetup = RunSetup & {
  readonly onCrash?: (error: unknown) => void | Promise<void>;
};
