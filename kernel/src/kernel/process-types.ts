import type { CapabilitySelection, HandlerContext } from "./capabilities.ts";
import type { Envelope } from "./types.ts";
import type { CapabilityAddonName } from "./validation/context.ts";

export type StopSignal = "SIGINT" | "SIGTERM";

// Interface: Seam for reading keys from and drawing on a terminal. `enter`
// switches to raw mode and hides the cursor; `leave` restores synchronously
// and is safe to call twice; `draw` replaces the last drawing.
export type TerminalAdapter = {
  readonly size: () => { readonly columns: number; readonly rows: number };
  readonly enter: () => void;
  readonly leave: () => void;
  readonly keys: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
  readonly draw: (lines: readonly string[]) => void;
};

export type ProcessHost = {
  readonly write: (
    stream: "stdout" | "stderr",
    bytes: Uint8Array,
  ) => Promise<boolean>;
  readonly exit: (code: number) => void;
  readonly onSignal: (listener: (signal: StopSignal) => void) => void;
  readonly onCrash: (listener: (error: unknown) => void) => void;
  readonly now: () => number;
  readonly terminal: () => TerminalAdapter | undefined;
};

// Interface: What an add-on learns about the run it serves. `signal` aborts at the first
// stop request or at the deadline: no new work may start after that. `terminal` is
// present only in an interactive run.
export type RunControl = {
  readonly runId: string;
  readonly commandIdentity: string;
  readonly summary: string;
  readonly signal: AbortSignal;
  readonly terminal?: TerminalAdapter;
};

export type AttachedAddon<Capability> = {
  readonly capability: Capability;
  // Interface: Bounded shutdown of owned resources. `limitMilliseconds` caps every
  // declared budget. Resolves true only when every owned resource was observed
  // stopped; an attempt is never reported as termination.
  readonly settle: (limitMilliseconds?: number) => Promise<boolean>;
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
  readonly emergencyRecord?: (facts: EmergencyFacts) => void;
};

export type InProcessSetup = RunSetup & {
  readonly onCrash?: (error: unknown) => void | Promise<void>;
  readonly terminal?: TerminalAdapter;
};
