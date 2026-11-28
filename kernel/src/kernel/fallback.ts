import type { ContractRuntime } from "./runtime.ts";
import type { StateObservation } from "./state-seam.ts";
import {
  incompleteEffects,
  internalResultCause,
  unchangedEffects,
} from "./state-causes.ts";
import type { Diagnostics, Effects, Envelope } from "./types.ts";
import {
  childLevel,
  fallbackLevelLimit,
  rootLevel,
  withinLevel,
} from "./validation/level.ts";
import { record } from "./validation/primitives.ts";
import { contractVersion } from "./validation/version.ts";

const fallbackMessage =
  "The result could not be delivered safely. Follow the guidance and inspect effects independently before any new run.";
const fallbackLimits = {
  bytes: 16_384,
  level: fallbackLevelLimit,
} as const;

export function unavailableStatus(
  reason: "status-invalid" | "status-unavailable",
): Diagnostics {
  return { status: "unavailable", reason, trusted: {} };
}

export type TrustedRun = {
  readonly runId: string;
  readonly commandIdentity: string;
  readonly handlerEntered: boolean;
  readonly summary?: StateObservation;
  readonly superseded?: readonly string[];
  readonly diagnostics?: Diagnostics;
};

function select(
  effectClass: string,
  trusted: TrustedRun,
): { readonly causeCode: string; readonly effects: Effects } {
  if (!trusted.handlerEntered)
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
  const superseded =
    command.effectClass === "inspect" ? undefined : trusted.superseded;
  const envelope = {
    contractVersion,
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
      ...(superseded === undefined ? {} : { superseded: [...superseded] }),
      ...station.guidance,
    },
  };
  return trusted.diagnostics
    ? { ...envelope, diagnostics: trusted.diagnostics }
    : envelope;
}

export async function fallbackText(
  runtime: ContractRuntime,
  trusted: TrustedRun,
): Promise<{ readonly text: string; readonly envelope: Envelope } | undefined> {
  try {
    const command = runtime.commands.find(
      (item) => item.commandIdentity === trusted.commandIdentity,
    );
    if (!command) return undefined;
    const selected = select(command.effectClass, trusted);
    const unknown = trusted.summary
      ? { causeCode: internalResultCause.unknown, effects: incompleteEffects }
      : undefined;
    const degraded: TrustedRun | undefined = trusted.diagnostics
      ? { ...trusted, diagnostics: unavailableStatus("status-unavailable") }
      : undefined;
    const attempts = [
      [trusted, selected],
      [degraded, selected],
      [trusted, unknown],
      [degraded, unknown],
    ] as const;
    let text: string | undefined;
    for (const [run, chosen] of attempts) {
      if (text !== undefined || !run || !chosen) continue;
      text = encodeBounded(construct(runtime, run, chosen));
    }
    if (text === undefined) return undefined;
    const checked = await runtime.validate(JSON.parse(text));
    return checked.ok ? { text, envelope: checked.value } : undefined;
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
