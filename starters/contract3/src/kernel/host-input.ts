import type { InputSchema } from "./input-types.ts";
import { inputSchema } from "./validation/input.ts";

// Only host-owned declarations reach this admission path. External schema
// patterns remain syntax-checked and matched in the terminable worker.
export function admitHostInput(schema: InputSchema): void {
  if (!inputSchema(schema)) throw new Error("Invalid input declaration.");
  for (const slot of [...schema.arguments, ...schema.options]) {
    const value = slot.value;
    if (value === null || value.kind !== "string" || value.pattern === null)
      continue;
    try {
      // inputSchema already enforces the finite source-length bound. Compile
      // the same Unicode, whole-string grammar as the worker; never match here.
      void new RegExp(`^(?:${value.pattern})$`, "u");
    } catch {
      throw new Error("Invalid Unicode pattern in input declaration.");
    }
  }
}
