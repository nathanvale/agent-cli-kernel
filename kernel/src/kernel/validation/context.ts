import type { CapabilitySelection, HandlerContext } from "../capabilities.ts";
import { record } from "./primitives.ts";
export const capabilityMethods = {
  programs: ["inspect", "supplied", "domain"],
  approval: ["check"],
  diagnostics: ["record"],
} as const satisfies Record<keyof CapabilitySelection, readonly string[]>;
export type CapabilityAddonName = keyof typeof capabilityMethods;
export function capabilityAddonName(key: string): key is CapabilityAddonName {
  return Object.hasOwn(capabilityMethods, key);
}
export const addonNames: readonly CapabilityAddonName[] = Object.freeze(
  Object.keys(capabilityMethods).filter(capabilityAddonName),
);
// Platform: instanceof and an own `aborted` property can both be forged with
// Object.create(AbortSignal.prototype). The prototype's own `aborted` getter
// throws for any object that is not a real AbortSignal, a Proxy of one
// included, so reading it through the prototype is the brand check.
function abortSignal(value: unknown): value is AbortSignal {
  try {
    if (!(value instanceof AbortSignal)) return false;
    return (
      typeof Reflect.get(AbortSignal.prototype, "aborted", value) === "boolean"
    );
  } catch {
    return false;
  }
}
export function abortSignalOf(
  context: Readonly<Record<string, unknown>>,
): AbortSignal | undefined {
  if (!Object.hasOwn(context, "signal")) return new AbortController().signal;
  return abortSignal(context.signal) ? context.signal : undefined;
}
export function handlerContext<C extends CapabilitySelection>(
  value: unknown,
  selection: C,
  changing = false,
): value is HandlerContext<C> {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        !(changing && key === "state") &&
        key !== "signal" &&
        !Object.hasOwn(selection, key),
    )
  )
    return false;
  return Object.entries(selection).every(([key, enabled]) => {
    if (enabled !== true || !capabilityAddonName(key)) return false;
    const capability = value[key];
    return (
      record(capability) &&
      capabilityMethods[key].every(
        (name) => typeof capability[name] === "function",
      )
    );
  });
}

export function approvalContext(value: unknown): value is {
  readonly approval: import("../capabilities.ts").ApprovalCapability;
} {
  return (
    record(value) &&
    record(value.approval) &&
    typeof value.approval.check === "function"
  );
}
export function withState(
  value: unknown,
  state: import("../capabilities.ts").StateCapability<string> | undefined,
): unknown {
  return record(value) ? { ...value, state } : { state };
}
