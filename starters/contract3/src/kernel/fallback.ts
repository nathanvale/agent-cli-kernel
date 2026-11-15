import type { ContractRuntime } from "./runtime.ts";
import type { StateObservation } from "./state-seam.ts";
import {
  incompleteEffects,
  internalResultCause,
  unchangedEffects,
} from "./state-causes.ts";
import type { Effects } from "./types.ts";
import { record } from "./validation/primitives.ts";

// LIFE-9 and LIFE-10: one bounded fallback, always contract 3.0.0.
export const fallbackMessage =
  "The result could not be delivered safely. Follow the guidance and inspect effects independently before any new run.";
// The 16,384-byte bound includes the trailing newline. Depth counts nested
// containers, the envelope object being depth 1.
export const fallbackLimits = { bytes: 16_384, depth: 8 } as const;

export type TrustedRun = {
  readonly runId: string;
  readonly commandIdentity: string;
  // True once the operation was dispatched to its handler.
  readonly dispatched: boolean;
  // The state add-on's transaction proof for this run, when one exists.
  readonly summary?: StateObservation;
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
  readonly close: "]" | "}";
  readonly items: readonly (readonly [string | undefined, unknown])[];
  index: number;
};
export type Limits = { readonly bytes: number; readonly depth: number };

function scalar(value: unknown): string | undefined {
  return value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? JSON.stringify(value)
    : undefined;
}

function frame(value: unknown): Frame | undefined {
  if (Array.isArray(value))
    return {
      close: "]",
      items: Array.from(value, (item: unknown) => [undefined, item] as const),
      index: 0,
    };
  if (record(value))
    return { close: "}", items: Object.entries(value), index: 0 };
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

// Writes one value: a scalar, or the opening of a container frame.
function open(
  value: unknown,
  stack: Frame[],
  output: Output,
  limits: Limits,
): boolean {
  const literal = scalar(value);
  if (literal !== undefined) return output.push(literal);
  const next = frame(value);
  if (!next || stack.length + 1 > limits.depth) return false;
  stack.push(next);
  return output.push(next.close === "]" ? "[" : "{");
}

// The guarded nonrecursive encoder used only by the fallback. It accepts plain
// JSON values, at most `fallbackLimits.depth` nested containers and at most
// `fallbackLimits.bytes` UTF-8 bytes including the trailing newline.
export function encodeBounded(
  value: unknown,
  limits: Limits = fallbackLimits,
): string | undefined {
  const output = new Output(limits.bytes);
  const stack: Frame[] = [];
  if (!open(value, stack, output, limits)) return undefined;
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    const entry = top.items[top.index];
    if (!entry) {
      stack.pop();
      if (!output.push(top.close)) return undefined;
      continue;
    }
    const separator = top.index++ > 0 ? "," : "";
    const key = entry[0] === undefined ? "" : `${JSON.stringify(entry[0])}:`;
    if (!output.push(separator + key) || !open(entry[1], stack, output, limits))
      return undefined;
  }
  return output.text();
}
