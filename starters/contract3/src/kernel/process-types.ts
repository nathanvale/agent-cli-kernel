import type {
  ApprovalCapability,
  DiagnosticsCapability,
  ProgramsCapability,
} from "./capabilities.ts";

export type StopSignal = "SIGINT" | "SIGTERM";

// The process streams, exit, signals, crash hooks and clock, owned by the one
// writer and the lifecycle. The real adapter is processHost(); a test-owned
// fault fixture may wrap it. Host command code never receives it.
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
};

export type RunAddon<Capability> = {
  readonly attach: (run: RunControl) => AttachedAddon<Capability>;
};

export type EmergencyFacts = {
  readonly runId: string;
  readonly commandIdentity: string | null;
  readonly phase: "preparing" | "dispatched" | "emitting" | "drained";
};

export type RunSetup = {
  readonly host?: ProcessHost;
  readonly addons?: {
    readonly programs?: RunAddon<ProgramsCapability>;
    readonly approval?: RunAddon<ApprovalCapability>;
    readonly diagnostics?: RunAddon<DiagnosticsCapability>;
  };
  // At most one bounded synchronous recording attempt on a catchable crash
  // (LIFE-6a). The state add-on supplies it; without one nothing is written.
  readonly emergencyRecord?: (facts: EmergencyFacts) => void;
};
