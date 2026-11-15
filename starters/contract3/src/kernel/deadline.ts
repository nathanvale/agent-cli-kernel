import type { Validation } from "./types.ts";

export const deadlineOption = {
  name: "--deadline-ms",
  valueName: "positive-integer",
  summary: "Limit supported command work to a positive number of milliseconds.",
} as const;
export type DeadlineInput = {
  readonly tokens: readonly string[];
  readonly deadlineMilliseconds?: number;
};
export type DeadlineValidation<T> = Validation<T> & {
  readonly deadlineMilliseconds?: number;
};
export function splitDeadline(
  argv: readonly unknown[],
): Validation<DeadlineInput> {
  const tokens: string[] = [];
  let literal = false;
  let deadlineMilliseconds: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (typeof token !== "string")
      return { ok: false, path: "argv", reason: "expected string tokens" };
    if (token === "--") literal = true;
    if (literal || token !== deadlineOption.name) {
      tokens.push(token);
      continue;
    }
    const value = argv[++index];
    if (
      deadlineMilliseconds !== undefined ||
      typeof value !== "string" ||
      !/^[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      return {
        ok: false,
        path: deadlineOption.name,
        reason: "expected one positive safe integer deadline",
      };
    deadlineMilliseconds = Number(value);
  }
  return {
    ok: true,
    value: {
      tokens,
      ...(deadlineMilliseconds === undefined ? {} : { deadlineMilliseconds }),
    },
  };
}
