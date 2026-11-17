import type { InputSchema } from "./input-types.ts";
import { inputSchema } from "./validation/input.ts";

export function validateHostInput(schema: InputSchema): void {
  if (!inputSchema(schema)) throw new Error("Invalid input declaration.");
  for (const slot of [...schema.arguments, ...schema.options]) {
    const value = slot.value;
    if (value === null || value.kind !== "string" || value.pattern === null)
      continue;
    try {
      void new RegExp(value.pattern, "u");
      void new RegExp(`^(?:${value.pattern})$`, "u");
    } catch {
      throw new Error("Invalid Unicode pattern in input declaration.");
    }
  }
}
