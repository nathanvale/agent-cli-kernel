import type { InputRegistration } from "./future-input.ts";
import { resultContext, checkedResult } from "./command-result.ts";
import type { CommandResult, ResultContext } from "./command-result.ts";
import { validateFutureInputs } from "./future-input.ts";
import { stateContext } from "./validation/state.ts";
import { knownRoute } from "./state-seam.ts";
import type { IfNoResult, StateCapability } from "./capabilities.ts";
import type { CapabilitySelection, HandlerContext } from "./capabilities.ts";
import type { InputSchema, ParsedInput } from "./input-types.ts";
import { parseInput, acceptsRootInput } from "./input.ts";
import { admitHostInput } from "./host-input.ts";
import { handlerContext, approvalContext } from "./validation/context.ts";
import { record, text } from "./validation/primitives.ts";
import { freeze } from "./stations.ts";
import type { DeclaredStation } from "./stations.ts";
import type { Validation } from "./types.ts";
export type CommandSummary<Identity extends string = string> = {
  readonly commandIdentity: Identity;
  readonly route: readonly string[];
  readonly summary: string;
  readonly effectClass: "inspect" | "repository-local" | "external";
};
export type CommandDeclaration<Identity extends string = string> =
  CommandSummary<Identity> & {
    readonly input: InputSchema;
    readonly stations: readonly DeclaredStation[];
    readonly capabilities: CapabilitySelection;
    readonly effects?: readonly string[];
    readonly futureBindings?: Readonly<Record<string, string>>;
    readonly ifNoResult?: IfNoResult;
    readonly heldLockCause?: string;
    readonly unresolvedCaseCause?: string;
    readonly execute?: (
      argv: unknown,
      context: unknown,
      runId: string,
      invocation?: object,
      registration?: InputRegistration,
    ) => Promise<Validation<CommandResult<Identity>>>;
  };
export function admitCommandIdentity(identity: string): void {
  if (!text(identity) || new TextEncoder().encode(identity).byteLength > 128)
    throw new Error(
      "Command identity must be nonempty and at most 128 UTF-8 bytes.",
    );
}
// CMD-9 steps 1 and 2: switches are removed before exact route matching, so an
// empty or option-like token could never select its command (F04).
export function admitRouteTokens(route: readonly string[]): void {
  for (const token of route)
    if (!text(token) || token.startsWith("-"))
      throw new Error(
        `Route token ${JSON.stringify(token)} is empty or option-like and can never be matched.`,
      );
}
export function admitRootOperation(
  route: readonly string[],
  input: InputSchema,
): void {
  if (
    route.length === 0 &&
    input.arguments.length === 0 &&
    input.options.length === 0
  )
    throw new Error("Root operation requires a declared option or operand.");
}
// Reads each own context property once into a plain object. The handler then
// receives exactly the values that were validated; a hidden or accessor
// property is refused instead of being read twice or dropped by a spread (F10).
function contextSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor =
      typeof key === "string"
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined;
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    snapshot[String(key)] = descriptor.value;
  }
  return snapshot;
}
export function command<
  const Identity extends string,
  const I extends InputSchema,
  const C extends CapabilitySelection = Record<never, never>,
  const S extends readonly DeclaredStation[] = readonly [],
>(spec: {
  readonly identity: Identity;
  readonly route: readonly string[];
  readonly summary: string;
  readonly input: I;
  readonly futureBindings?: Readonly<
    Record<string, keyof ParsedInput<I> & string>
  >;
  readonly capabilities: C;
  readonly stations?: S;
  readonly run: (
    input: ParsedInput<I>,
    context: HandlerContext<C> & ResultContext<Identity, S, "inspect">,
  ) => CommandResult<Identity> | Promise<CommandResult<Identity>>;
}) {
  freeze(spec);
  admitHostInput(spec.input);
  admitCommandIdentity(spec.identity);
  admitRootOperation(spec.route, spec.input);
  admitRouteTokens(spec.route);
  if (!text(spec.summary)) throw new Error("Invalid command declaration.");
  if (
    spec.stations?.some((station) => station.commandIdentity !== spec.identity)
  )
    throw new Error("Station belongs to another command.");
  const input = structuredClone(spec.input);
  const capabilities = spec.capabilities;
  const declaration = freeze({
    commandIdentity: spec.identity,
    route: [...spec.route],
    summary: spec.summary,
    effectClass: "inspect" as const,
    input,
    futureBindings: structuredClone(spec.futureBindings ?? {}),
    stations: structuredClone(spec.stations ?? []),
    capabilities: capabilities ?? {},
    async execute(
      argv: unknown,
      context: unknown,
      runId: string,
      invocation: object = Object.freeze({}),
      registration?: InputRegistration,
    ): Promise<Validation<CommandResult<Identity>>> {
      const parsed = await parseInput(input, argv);
      if (!parsed.ok) return parsed;
      if (!acceptsRootInput(spec.route, parsed.value))
        return {
          ok: false,
          path: "input",
          reason: "Root operation requires an option or operand.",
        };
      const future = await validateFutureInputs(
        declaration,
        parsed.value,
        registration,
      );
      if (!future.ok) return future;
      const checked = contextSnapshot(context);
      if (!checked || !handlerContext(checked, capabilities))
        return {
          ok: false,
          path: "capabilities",
          reason: "undeclared or unavailable capability",
        };
      return checkedResult(
        await spec.run(parsed.value, {
          ...checked,
          ...resultContext(declaration, runId, invocation),
        }),
        spec.identity,
        runId,
        invocation,
      );
    },
  });
  return declaration;
}

export function changing<
  const Identity extends string,
  const I extends InputSchema,
  const Effect extends string,
  const S extends readonly DeclaredStation[],
  const C extends CapabilitySelection = Record<never, never>,
>(
  spec: {
    readonly identity: Identity;
    readonly route: readonly string[];
    readonly summary: string;
    readonly input: I;
    readonly futureBindings?: Readonly<
      Record<string, keyof ParsedInput<I> & string>
    >;
    readonly capabilities: C;
    readonly effectClass: "repository-local" | "external";
    readonly effects: readonly [Effect, ...Effect[]];
    readonly ifNoResult: IfNoResult;
    readonly heldLockCause: string;
    readonly unresolvedCaseCause: string;
    readonly stations: S;
    readonly run: (
      input: ParsedInput<I>,
      context: HandlerContext<C> & {
        readonly state: StateCapability<Effect>;
      } & ResultContext<Identity, S, "repository-local" | "external">,
    ) => Promise<CommandResult<Identity>>;
  } & (C extends { readonly approval: true }
    ? {
        readonly approval: (
          input: ParsedInput<I>,
        ) => import("./capabilities.ts").ApprovalRequest;
      }
    : { readonly approval?: never }),
) {
  freeze(spec);
  admitHostInput(spec.input);
  admitCommandIdentity(spec.identity);
  admitRootOperation(spec.route, spec.input);
  admitRouteTokens(spec.route);
  if (!knownRoute(spec.ifNoResult))
    throw new Error("ifNoResult must come from the admitted state add-on.");
  if (
    spec.heldLockCause === spec.unresolvedCaseCause ||
    !spec.stations.some((item) => item.causeCode === spec.heldLockCause) ||
    !spec.stations.some((item) => item.causeCode === spec.unresolvedCaseCause)
  )
    throw new Error(
      "Changing commands need distinct coordination refusal stations.",
    );
  if (
    spec.effects.length === 0 ||
    new Set(spec.effects).size !== spec.effects.length
  )
    throw new Error("Invalid changing declaration.");
  const declaration = freeze({
    commandIdentity: spec.identity,
    route: [...spec.route],
    summary: spec.summary,
    effectClass: spec.effectClass,
    effects: [...spec.effects],
    ifNoResult: spec.ifNoResult,
    heldLockCause: spec.heldLockCause,
    unresolvedCaseCause: spec.unresolvedCaseCause,
    input: structuredClone(spec.input),
    futureBindings: structuredClone(spec.futureBindings ?? {}),
    stations: structuredClone(spec.stations),
    capabilities: spec.capabilities ?? {},
    async execute(
      argv: unknown,
      context: unknown,
      runId: string,
      invocation: object = Object.freeze({}),
      registration?: InputRegistration,
    ): Promise<Validation<CommandResult<Identity>>> {
      const parsed = await parseInput(spec.input, argv);
      if (!parsed.ok) return parsed;
      if (!acceptsRootInput(spec.route, parsed.value))
        return {
          ok: false,
          path: "input",
          reason: "Root operation requires an option or operand.",
        };
      const future = await validateFutureInputs(
        declaration,
        parsed.value,
        registration,
      );
      if (!future.ok) return future;
      const checked = contextSnapshot(context);
      if (
        !checked ||
        !handlerContext(checked, spec.capabilities, true) ||
        !stateContext(checked, spec.effects)
      )
        return { ok: false, path: "capabilities", reason: "state unavailable" };
      if (
        spec.capabilities?.approval &&
        (!spec.approval ||
          !approvalContext(checked) ||
          !(await checked.approval.check(spec.approval(parsed.value))))
      )
        return { ok: false, path: "approval", reason: "approval required" };
      return checkedResult(
        await spec.run(parsed.value, {
          ...checked,
          ...resultContext(declaration, runId, invocation),
        }),
        spec.identity,
        runId,
        invocation,
      );
    },
  });
  return declaration;
}
