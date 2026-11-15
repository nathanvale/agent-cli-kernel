import type { CapabilitySelection, HandlerContext } from "../capabilities.ts";
import { record } from "./primitives.ts";
export function handlerContext<C extends CapabilitySelection>(
  value: unknown,
  selection: C,
  changing = false,
): value is HandlerContext<C> {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !(changing && key === "state") && !Object.hasOwn(selection, key),
    )
  )
    return false;
  const methods = {
    programs: ["inspect", "supplied", "domain"],
    approval: ["check"],
    diagnostics: ["record"],
  } as const;
  return Object.entries(selection).every(([key, enabled]) => {
    if (
      enabled !== true ||
      (key !== "programs" && key !== "approval" && key !== "diagnostics")
    )
      return false;
    const capability = value[key];
    return (
      record(capability) &&
      methods[key].every((name) => typeof capability[name] === "function")
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
