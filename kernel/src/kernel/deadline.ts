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
export function parseDeadlineValue(value: string): Validation<number> {
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
    ? { ok: true, value: Number(value) }
    : {
        ok: false,
        path: deadlineOption.name,
        reason: "expected a positive safe integer deadline",
      };
}
export function splitDeadline(
  argv: readonly unknown[],
): Validation<DeadlineInput> {
  const split = splitDeadlineTokens(argv);
  if (!split.ok) return split;
  const { tokens, deadlineValue } = split.value;
  if (deadlineValue === undefined) return { ok: true, value: { tokens } };
  const parsed = parseDeadlineValue(deadlineValue);
  return parsed.ok
    ? { ok: true, value: { tokens, deadlineMilliseconds: parsed.value } }
    : parsed;
}
const deadlinePrefix = `${deadlineOption.name}=`;
const deadlineValueError = {
  ok: false,
  path: deadlineOption.name,
  reason: "expected one deadline value",
} as const;
function deadlineTokenValue(
  argv: readonly unknown[],
  index: number,
  token: string,
): { readonly value: string; readonly nextIndex: number } | "invalid" | null {
  if (token === deadlineOption.name) {
    const value = argv[index + 1];
    return typeof value === "string"
      ? { value, nextIndex: index + 1 }
      : "invalid";
  }
  if (token.startsWith(deadlinePrefix))
    return { value: token.slice(deadlinePrefix.length), nextIndex: index };
  return null;
}
export function splitDeadlineTokens(argv: readonly unknown[]): Validation<{
  readonly tokens: readonly string[];
  readonly deadlineValue?: string;
}> {
  const tokens: string[] = [];
  let literal = false;
  let deadlineValue: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (typeof token !== "string")
      return { ok: false, path: "argv", reason: "expected string tokens" };
    if (token === "--") literal = true;
    const found = literal ? null : deadlineTokenValue(argv, index, token);
    if (found === null) {
      tokens.push(token);
      continue;
    }
    if (found === "invalid" || deadlineValue !== undefined)
      return deadlineValueError;
    deadlineValue = found.value;
    index = found.nextIndex;
  }
  return {
    ok: true,
    value: deadlineValue === undefined ? { tokens } : { tokens, deadlineValue },
  };
}
