import type { ContractRuntime } from "./runtime.ts";
import type { StateObservation } from "./state-seam.ts";
import {
  incompleteEffects,
  internalResultCause,
  unchangedEffects,
} from "./state-causes.ts";
import type { Diagnostics, Effects } from "./types.ts";
import {
  childLevel,
  fallbackLevelLimit,
  rootLevel,
  withinLevel,
} from "./validation/level.ts";
import { record } from "./validation/primitives.ts";

// LIFE-9 and LIFE-10: one bounded fallback, always contract 3.0.0.
export const fallbackMessage =
  "The result could not be delivered safely. Follow the guidance and inspect effects independently before any new run.";
// The 16,384-byte bound includes the trailing newline. Depth counts nested
// The level limit follows the one nesting rule in validation/level.ts.
export const fallbackLimits = {
  bytes: 16_384,
  level: fallbackLevelLimit,
} as const;

// The one owner of the diagnostics unavailable variant the kernel builds
// (DIAG-3): no independently trusted field survives, so `trusted` is empty.
export function unavailableStatus(
  reason: "status-invalid" | "status-unavailable",
): Diagnostics {
  return { status: "unavailable", reason, trusted: {} };
}

export type TrustedRun = {
  readonly runId: string;
  readonly commandIdentity: string;
  // True once the operation was dispatched to its handler.
  readonly dispatched: boolean;
  // The state add-on's transaction proof for this run, when one exists.
  readonly summary?: StateObservation;
  // The diagnostics status the writer froze and validated (LIFE-7 step 1),
  // when one is due. LIFE-9 step 2 includes it in the fallback.
  readonly diagnostics?: Diagnostics;
};

function select(
  effectClass: string,
  trusted: TrustedRun,
): { readonly causeCode: string; readonly effects: Effects } {
  if (!trusted.dispatched)
    return { causeCode: "INTERNAL_PREPARATION", effects: unchangedEffects };
  if (effectClass === "inspect")
    return {
      causeCode: internalResultCause.unchanged,
      effects: unchangedEffects,
    };
  if (!trusted.summary)
    return {
      causeCode: internalResultCause.unknown,
      effects: incompleteEffects,
    };
  return {
    causeCode: internalResultCause[trusted.summary.transactionState],
    effects: {
      completed: [...trusted.summary.effects.completed],
      remaining: [...trusted.summary.effects.remaining],
      uncertain: [...trusted.summary.effects.uncertain],
      inventoryComplete: trusted.summary.effects.inventoryComplete,
    },
  };
}

function construct(
  runtime: ContractRuntime,
  trusted: TrustedRun,
  selected: { readonly causeCode: string; readonly effects: Effects },
) {
  const command = runtime.commands.find(
    (item) => item.commandIdentity === trusted.commandIdentity,
  );
  const station = runtime.stations
    .get(trusted.commandIdentity)
    ?.find((item) => item.causeCode === selected.causeCode);
  if (!command || !station) return undefined;
  return {
    contractVersion: "3.0.0",
    message: fallbackMessage,
    availablePaths: [],
    result: {
      runId: trusted.runId,
      commandIdentity: trusted.commandIdentity,
      outcome: station.row.outcome,
      effectClass: command.effectClass,
      transactionState: station.row.transactionState,
      causeCode: station.causeCode,
      failureClass: station.row.failureClass,
      exitCode: station.row.exitCode,
      data: null,
      retryable: false,
      repairAction: station.repairAction,
      effects: selected.effects,
      ...station.guidance,
    },
    ...(trusted.diagnostics ? { diagnostics: trusted.diagnostics } : {}),
  };
}

// Builds, encodes and validates the one fallback envelope. Returns undefined on
// any construction, encoding or validation failure: the caller terminates.
export async function fallbackText(
  runtime: ContractRuntime,
  trusted: TrustedRun,
): Promise<string | undefined> {
  try {
    const command = runtime.commands.find(
      (item) => item.commandIdentity === trusted.commandIdentity,
    );
    if (!command) return undefined;
    const selected = select(command.effectClass, trusted);
    let text = encodeBounded(construct(runtime, trusted, selected));
    // Seam review S1: a valid status too large for the bound is replaced by
    // the unavailable variant, as effects that do not fit are, so the status
    // never stops the one fallback envelope.
    if (text === undefined && trusted.diagnostics) {
      trusted = {
        ...trusted,
        diagnostics: unavailableStatus("status-unavailable"),
      };
      text = encodeBounded(construct(runtime, trusted, selected));
    }
    // Trusted effect identities that do not fit are reported as unknown with
    // an incomplete inventory; nothing is fabricated.
    if (text === undefined && trusted.summary)
      text = encodeBounded(
        construct(runtime, trusted, {
          causeCode: internalResultCause.unknown,
          effects: incompleteEffects,
        }),
      );
    if (text === undefined) return undefined;
    const checked = await runtime.validate(JSON.parse(text));
    return checked.ok ? text : undefined;
  } catch {
    return undefined;
  }
}

type Frame = {
  readonly level: number;
  readonly close: "]" | "}";
  readonly items: readonly (readonly [string | undefined, unknown])[];
  index: number;
};
export type Limits = { readonly bytes: number; readonly level: number };

function scalar(value: unknown): string | undefined {
  return value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? JSON.stringify(value)
    : undefined;
}

function frame(value: unknown, level: number): Frame | undefined {
  if (Array.isArray(value))
    return {
      level,
      close: "]",
      items: Array.from(value, (item: unknown) => [undefined, item] as const),
      index: 0,
    };
  if (record(value))
    return { level, close: "}", items: Object.entries(value), index: 0 };
  return undefined;
}

// Bounded output: every write is counted, including the final newline.
class Output {
  private readonly encoder = new TextEncoder();
  private readonly parts: string[] = [];
  private bytes = 1;
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  push(text: string): boolean {
    this.bytes += this.encoder.encode(text).byteLength;
    this.parts.push(text);
    return this.bytes <= this.limit;
  }
  text(): string {
    return this.parts.join("");
  }
}

// Writes one value at `level`: a scalar, or the opening of a container frame.
// Every value, scalar or container, must sit within the level limit.
function open(
  value: unknown,
  level: number,
  stack: Frame[],
  output: Output,
  limits: Limits,
): boolean {
  if (!withinLevel(level, limits.level)) return false;
  const literal = scalar(value);
  if (literal !== undefined) return output.push(literal);
  const next = frame(value, level);
  if (!next) return false;
  stack.push(next);
  return output.push(next.close === "]" ? "[" : "{");
}

// The guarded nonrecursive encoder used only by the fallback. It accepts plain
// JSON values with every value at most `fallbackLimits.level` levels below the
// root (level 0) and at most `fallbackLimits.bytes` UTF-8 bytes including the
// trailing newline.
export function encodeBounded(
  value: unknown,
  limits: Limits = fallbackLimits,
): string | undefined {
  const output = new Output(limits.bytes);
  const stack: Frame[] = [];
  if (!open(value, rootLevel, stack, output, limits)) return undefined;
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    const entry = top.items[top.index];
    if (!entry) {
      stack.pop();
      if (!output.push(top.close)) return undefined;
      continue;
    }
    const separator = top.index++ > 0 ? "," : "";
    const key = entry[0] === undefined ? "" : `${JSON.stringify(entry[0])}:`;
    if (
      !output.push(separator + key) ||
      !open(entry[1], childLevel(top.level), stack, output, limits)
    )
      return undefined;
  }
  return output.text();
}
