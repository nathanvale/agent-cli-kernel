import type { CapabilitySelection, HandlerContext } from "./capabilities.ts";
import type { CapabilityAddonName } from "./validation/context.ts";

export type StopSignal = "SIGINT" | "SIGTERM";

// The process streams, exit, signals, crash hooks and clock, owned by the one
// writer and the lifecycle. Kernel-internal: the public RunSetup cannot
// replace it. The real adapter is processHost().
export type ProcessHost = {
  // Resolves true after the bytes drained to the stream, false on any error.
  readonly write: (
    stream: "stdout" | "stderr",
    bytes: Uint8Array,
  ) => Promise<boolean>;
  readonly exit: (code: number) => void;
  readonly onSignal: (listener: (signal: StopSignal) => void) => void;
  readonly onCrash: (listener: () => void) => void;
  // Monotonic milliseconds.
  readonly now: () => number;
};

// What an add-on learns about the run it serves. `signal` aborts at the first
// stop request or at the deadline: no new work may start after that.
export type RunControl = {
  readonly runId: string;
  readonly commandIdentity: string;
  readonly summary: string;
  readonly signal: AbortSignal;
};

export type AttachedAddon<Capability> = {
  readonly capability: Capability;
  // Bounded shutdown of owned resources. `limitMilliseconds` caps every
  // declared budget. Resolves true only when every owned resource was observed
  // stopped; an attempt is never reported as termination.
  readonly settle: (limitMilliseconds?: number) => Promise<boolean>;
  // Synchronous forced termination attempt with no waiting.
  readonly killNow: () => void;
  // Status seam (LIFE-7 step 1, DIAG-14). Offered only by an add-on whose
  // RunAddon sets `reportsStatus`. Called at most once, after the domain
  // result and recovery are frozen, with the flush budget (500 ms). Resolves
  // the raw diagnostics status; the kernel treats it as untrusted, bounds the
  // wait itself and validates the value alone. On this path it replaces
  // `settle`: the add-on is not counted as an owned program.
  readonly freeze?: (limitMilliseconds: number) => Promise<unknown>;
};

export type RunAddon<Capability> = {
  readonly attach: (run: RunControl) => AttachedAddon<Capability>;
  // A status-reporting add-on attaches when its declaring command reaches
  // handler entry, before the handler runs, so a status exists even when the handler
  // never uses it. Its attach must be effect-free. At most one per command.
  readonly reportsStatus?: true;
};

export type EmergencyFacts = {
  readonly runId: string;
  readonly commandIdentity: string | null;
  readonly phase: "preparing" | "handler-entered" | "emitting" | "drained";
};

// One add-on per declared capability name (validation/context.ts owns them).
export type CapabilityFor = HandlerContext<Required<CapabilitySelection>>;
export type RunSetup = {
  readonly addons?: {
    readonly [K in CapabilityAddonName]?: RunAddon<CapabilityFor[K]>;
  };
  // At most one bounded synchronous recording attempt on a catchable crash
  // (LIFE-6a). The state add-on supplies it; without one nothing is written.
  readonly emergencyRecord?: (facts: EmergencyFacts) => void;
};
