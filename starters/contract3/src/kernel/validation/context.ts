import type { CapabilitySelection, HandlerContext } from "../capabilities.ts";
import { record } from "./primitives.ts";
export function handlerContext<C extends CapabilitySelection>(
  value: unknown,
  selection: C,
): value is HandlerContext<C> {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(selection, key))
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
