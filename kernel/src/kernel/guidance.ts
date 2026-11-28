import type { DeclaredStation } from "./stations.ts";
import type { Handoff, NextStep, WireResult } from "./types.ts";
import { sameJson } from "./validation/json-equality.ts";
type GuidanceTemplateSlot = {
  readonly text: string;
  readonly bindingAllowed: boolean;
  readonly runValue: "argument" | "resource" | false;
};
function stepSlots(step: NextStep): GuidanceTemplateSlot[] {
  switch (step.kind) {
    case "command":
      return step.args.map((text) => ({
        text,
        bindingAllowed: true,
        runValue: "argument",
      }));
    case "instruction":
      return [{ text: step.text, bindingAllowed: false, runValue: false }];
    case "retry":
    case "done":
      return [];
  }
}
function guidanceTemplateSlots(
  station: DeclaredStation,
): readonly GuidanceTemplateSlot[] {
  const slots: GuidanceTemplateSlot[] =
    station.repairAction === null
      ? []
      : [
          {
            text: station.repairAction,
            bindingAllowed: false,
            runValue: false,
          },
        ];
  if (station.guidance.next)
    return [...slots, ...stepSlots(station.guidance.next)];
  const handoff = station.guidance.handoff;
  slots.push({ text: handoff.reason, bindingAllowed: false, runValue: false });
  if (handoff.resource)
    slots.push(
      { text: handoff.resource.kind, bindingAllowed: false, runValue: false },
      { text: handoff.resource.id, bindingAllowed: true, runValue: "resource" },
    );
  for (const entry of handoff.inspect) slots.push(...stepSlots(entry));
  return slots;
}
const tokens = [
  "runId",
  "completedEffects",
  "remainingEffects",
  "uncertainEffects",
  "idempotencyKey",
];
export function bindingNames(station: DeclaredStation): readonly string[] {
  const names = new Set<string>();
  for (const slot of guidanceTemplateSlots(station)) {
    const matches = [...slot.text.matchAll(/\{([^{}]*)\}/g)];
    if (slot.text.replace(/\{[^{}]*\}/g, "").match(/[{}]/))
      throw new Error("Malformed guidance template token.");
    for (const match of matches) {
      const token = match[1];
      if (token === undefined)
        throw new Error("Empty guidance template token.");
      if (tokens.includes(token)) continue;
      if (
        !/^binding\.[a-z][A-Za-z0-9]*$/.test(token) ||
        !slot.bindingAllowed ||
        slot.text !== `{${token}}`
      )
        throw new Error(
          "Invalid run binding placement or guidance template token.",
        );
      names.add(token.slice(8));
    }
  }
  return [...names].sort();
}
export function safeRunValue(
  value: string,
  routeTokens: readonly string[],
  argument: boolean,
): boolean {
  return (
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= 1024 &&
    !value.startsWith("-") &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    (!argument || !routeTokens.includes(value))
  );
}
function substitute(text: string, result: WireResult): string {
  return text.replace(/\{([^{}]*)\}/g, (_whole, token: string) => {
    switch (token) {
      case "runId":
        return result.runId;
      case "completedEffects":
        return JSON.stringify(result.effects.completed);
      case "remainingEffects":
        return JSON.stringify(result.effects.remaining);
      case "uncertainEffects":
        return JSON.stringify(result.effects.uncertain);
      case "idempotencyKey":
        if (result.idempotencyKey === undefined)
          throw new Error("Missing idempotency key.");
        return result.idempotencyKey;
      default: {
        const value = result.bindings?.[token.slice(8)];
        if (value === undefined) throw new Error("Missing run binding.");
        return value;
      }
    }
  });
}
function renderStep(step: NextStep, result: WireResult): NextStep {
  switch (step.kind) {
    case "command":
      return { ...step, args: step.args.map((arg) => substitute(arg, result)) };
    case "instruction":
      return { ...step, text: substitute(step.text, result) };
    case "retry":
    case "done":
      return step;
  }
}
function renderHandoff(handoff: Handoff, result: WireResult): Handoff {
  const renderInspection = (entry: Handoff["inspect"][number]) =>
    entry.kind === "command"
      ? { ...entry, args: entry.args.map((arg) => substitute(arg, result)) }
      : { ...entry, text: substitute(entry.text, result) };
  const [first, ...rest] = handoff.inspect;
  const rendered: Handoff = {
    ...handoff,
    reason: substitute(handoff.reason, result),
    inspect: [renderInspection(first), ...rest.map(renderInspection)],
  };
  return handoff.resource
    ? {
        ...rendered,
        resource: {
          kind: substitute(handoff.resource.kind, result),
          id: substitute(handoff.resource.id, result),
        },
      }
    : rendered;
}
export function renderGuidance(station: DeclaredStation, result: WireResult) {
  return {
    repairAction:
      station.repairAction === null
        ? null
        : substitute(station.repairAction, result),
    ...(station.guidance.next
      ? { next: renderStep(station.guidance.next, result) }
      : { handoff: renderHandoff(station.guidance.handoff, result) }),
  };
}
export function guidanceTemplatesAgree(
  station: DeclaredStation,
  result: WireResult,
  routeTokens: readonly string[],
): boolean {
  try {
    const names = bindingNames(station);
    if (
      names.length === 0
        ? result.bindings !== undefined
        : result.bindings === undefined ||
          JSON.stringify(Object.keys(result.bindings).sort()) !==
            JSON.stringify(names)
    )
      return false;
    for (const slot of guidanceTemplateSlots(station)) {
      if (!slot.runValue) continue;
      for (const match of slot.text.matchAll(/\{([^{}]*)\}/g))
        if (
          !safeRunValue(
            substitute(match[0], result),
            routeTokens,
            slot.runValue === "argument",
          )
        )
          return false;
    }
    const rendered = renderGuidance(station, result);
    return (
      rendered.repairAction === result.repairAction &&
      sameJson("next" in rendered ? rendered.next : undefined, result.next) &&
      sameJson(
        "handoff" in rendered ? rendered.handoff : undefined,
        result.handoff,
      )
    );
  } catch {
    return false;
  }
}

export type GuidanceTarget = {
  readonly target: import("./declarations.ts").CommandDeclaration | undefined;
  readonly args: readonly string[];
  readonly inspection: boolean;
};
export function guidanceTargets(
  command: import("./declarations.ts").CommandDeclaration,
  commands: readonly import("./declarations.ts").CommandDeclaration[],
): readonly GuidanceTarget[] {
  const targets: GuidanceTarget[] = [];
  for (const station of command.stations) {
    const steps = station.guidance.next
      ? [station.guidance.next]
      : station.guidance.handoff.inspect;
    for (const step of steps)
      if (step.kind === "command")
        targets.push({
          target: commands.find(
            (entry) => entry.commandIdentity === step.command,
          ),
          args: step.args,
          inspection: station.guidance.handoff !== undefined,
        });
  }
  return targets;
}
