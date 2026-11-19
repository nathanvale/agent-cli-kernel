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
// Platform: An object that only inherits AbortSignal.prototype passes instanceof
// and throws when `aborted` is read.
function abortSignal(value: unknown): value is AbortSignal {
  try {
    return value instanceof AbortSignal && typeof value.aborted === "boolean";
  } catch {
    return false;
  }
}
// Interface: The one owner of a context's abort signal. No `signal` key: a signal
// that never aborts. A real one: that signal. Anything else: undefined, and
// the caller refuses before the handler.
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
