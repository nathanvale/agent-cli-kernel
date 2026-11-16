import { programStopOf, recordProgramStop } from "./program-stop.ts";
import type { InputTable } from "./future-input.ts";
import { resultContext, checkedResult } from "./command-result.ts";
import type { CommandResult, ResultContext } from "./command-result.ts";
import { validateFutureInputs } from "./future-input.ts";
import { stateContext } from "./validation/state.ts";
import { isIssuedIfNoResult } from "./state-seam.ts";
import type { IfNoResult, StateCapability } from "./capabilities.ts";
import type {
  ApprovalRequest,
  CapabilitySelection,
  HandlerContext,
} from "./capabilities.ts";
import type { InputSchema, ParsedInput } from "./input-types.ts";
import { parseInput, acceptsRootInput } from "./input.ts";
import { validateHostInput } from "./host-input.ts";
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
      registration?: InputTable,
    ) => Promise<Validation<CommandResult<Identity>>>;
  };
// One owner for the shape rules of each declaration kind (repair 1, S1):
// command() and changing() call them as they construct, and contractFor
// calls them again for a raw CommandDeclaration (K1-5).
export function admitInspectShape(declaration: {
  readonly summary: unknown;
  readonly ifNoResult?: unknown;
  readonly capabilities: CapabilitySelection;
  readonly stations: readonly unknown[];
}): void {
  if (!text(declaration.summary))
    throw new Error("Invalid command declaration.");
  // DISC-10: only an inspect command that declares no approval may omit
  // its station table (X-K1-3 case B).
  if (
    declaration.capabilities.approval === true &&
    declaration.stations.length === 0
  )
    throw new Error(
      "An inspect command that declares approval declares its station table.",
    );
  // DISC-13: for an inspect command ifNoResult is null.
  if (declaration.ifNoResult !== undefined)
    throw new Error("An inspect command has no ifNoResult.");
}
// Accepted decision N1b: an inspect command that runs programs and
// supports a deadline declares its program-stop station, a failed and
// unchanged station with a handoff (WIRE-13, WIRE-14, WIRE-15). The kernel
// does not enforce its name (N1e).
function requireProgramStopStation(declaration: {
  readonly commandIdentity: string;
  readonly input: { readonly deadlineSupported: boolean };
  readonly capabilities: CapabilitySelection;
  readonly stations: readonly DeclaredStation[];
}): void {
  if (
    declaration.capabilities.programs !== true ||
    !declaration.input.deadlineSupported
  )
    return;
  const cause = programStopOf(declaration);
  const station = declaration.stations.find((item) => item.causeCode === cause);
  if (!station)
    throw new Error(
      `${declaration.commandIdentity} runs programs and supports a deadline, so it must declare its program-stop station (programStopCause).`,
    );
  if (
    station.row.outcome !== "failed" ||
    station.row.transactionState !== "unchanged" ||
    !station.guidance.handoff
  )
    throw new Error(
      `${declaration.commandIdentity}'s program-stop station ${station.causeCode} must be failed and unchanged, with a handoff.`,
    );
}
export function admitChangingShape(declaration: {
  readonly effectClass: unknown;
  readonly effects?: readonly unknown[];
  readonly heldLockCause?: unknown;
  readonly unresolvedCaseCause?: unknown;
  readonly stations: readonly { readonly causeCode: string }[];
}): void {
  if (
    declaration.effectClass !== "repository-local" &&
    declaration.effectClass !== "external"
  )
    throw new Error("Unknown effect class.");
  const declares = (cause: unknown) =>
    declaration.stations.some((item) => item.causeCode === cause);
  if (
    declaration.heldLockCause === declaration.unresolvedCaseCause ||
    !declares(declaration.heldLockCause) ||
    !declares(declaration.unresolvedCaseCause)
  )
    throw new Error(
      "Changing commands need distinct coordination refusal stations.",
    );
  const effects = declaration.effects ?? [];
  if (effects.length === 0 || new Set(effects).size !== effects.length)
    throw new Error("Invalid changing declaration.");
}
export function validateCommandIdentity(identity: string): void {
  if (!text(identity) || new TextEncoder().encode(identity).byteLength > 128)
    throw new Error(
      "Command identity must be nonempty and at most 128 UTF-8 bytes.",
    );
}
// CMD-9 steps 1 and 2: switches are removed before exact route matching, so an
// empty or option-like token could never select its command (F04).
export function validateRouteTokens(route: readonly string[]): void {
  for (const token of route)
    if (!text(token) || token.startsWith("-"))
      throw new Error(
        `Route token ${JSON.stringify(token)} is empty or option-like and can never be matched.`,
      );
}
export function validateRootOperation(
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
// CMD-9 steps 3 to 5 for one declaration: strict input, caller-supplied
// future bindings, the handler context and the non-consuming approval guard,
// for inspect and changing commands alike (CMD-4, CMD-15). Nothing attaches
// here; the returned entry is step 6 and receives the state capability, if
// any, only then (K1-3, K3-spec-6, K3-spec-7).
export type HandlerEntry<Identity extends string = string> = (
  state?: unknown,
) => Promise<Validation<CommandResult<Identity>>>;
export type Prepare<Identity extends string = string> = (
  argv: unknown,
  context: unknown,
  runId: string,
  invocation: object,
  registration?: InputTable,
) => Promise<Validation<HandlerEntry<Identity>>>;
const preparers = new WeakMap<object, Prepare>();
// The two-phase entry of a constructed declaration; a raw declaration has
// none and runs through its own execute.
export function preparerOf(declaration: object): Prepare | undefined {
  return preparers.get(declaration);
}
function register<D extends object, Identity extends string>(
  declaration: D,
  prepare: Prepare<Identity>,
): D {
  preparers.set(declaration, prepare);
  return declaration;
}
async function preflight<I extends InputSchema, C extends CapabilitySelection>(
  spec: {
    readonly route: readonly string[];
    readonly input: I;
    readonly capabilities: C;
    readonly approval?: (input: ParsedInput<I>) => ApprovalRequest;
  },
  declaration: CommandDeclaration,
  argv: unknown,
  context: unknown,
  registration: InputTable | undefined,
  changing: boolean,
): Promise<
  Validation<{
    readonly input: ParsedInput<I>;
    readonly context: Record<string, unknown> & HandlerContext<C>;
  }>
> {
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
  if (!checked || !handlerContext(checked, spec.capabilities, changing))
    return {
      ok: false,
      path: "capabilities",
      reason: changing
        ? "state unavailable"
        : "undeclared or unavailable capability",
    };
  // CMD-15: with no request mapper the guard cannot grant, so it denies.
  if (
    spec.capabilities.approval &&
    (!spec.approval ||
      !approvalContext(checked) ||
      !(await checked.approval.check(spec.approval(parsed.value))))
  )
    return { ok: false, path: "approval", reason: "approval required" };
  return { ok: true, value: { input: parsed.value, context: checked } };
}
// The single-call entry kept for direct callers: prepare, then enter with
// the state capability the caller's context carries.
function executeVia<Identity extends string>(prepare: Prepare<Identity>) {
  return async (
    argv: unknown,
    context: unknown,
    runId: string,
    invocation: object = Object.freeze({}),
    registration?: InputTable,
  ): Promise<Validation<CommandResult<Identity>>> => {
    const entry = await prepare(argv, context, runId, invocation, registration);
    return entry.ok
      ? entry.value(record(context) ? context.state : undefined)
      : entry;
  };
}
export function command<
  const Identity extends string,
  const I extends InputSchema,
  const C extends CapabilitySelection = Record<never, never>,
  const S extends readonly DeclaredStation[] = readonly [],
  const P extends string = never,
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
    readonly stations?: S;
    // Checked at declaration against the station table (requireProgramStopStation).
    readonly programStopCause?: P;
    readonly run: (
      input: ParsedInput<I>,
      context: HandlerContext<C> & ResultContext<Identity, S, "inspect", C, P>,
    ) => CommandResult<Identity> | Promise<CommandResult<Identity>>;
  } & (C extends { readonly approval: true }
    ? {
        // CMD-4: an inspect command's approval request. A raw declaration
        // cannot reach the guard without one (F1); the guard still denies
        // if it is missing.
        readonly approval: (input: ParsedInput<I>) => ApprovalRequest;
      }
    : { readonly approval?: never }),
) {
  freeze(spec);
  validateHostInput(spec.input);
  validateCommandIdentity(spec.identity);
  validateRootOperation(spec.route, spec.input);
  validateRouteTokens(spec.route);
  admitInspectShape({
    summary: spec.summary,
    capabilities: spec.capabilities,
    stations: spec.stations ?? [],
  });
  if (
    spec.stations?.some((station) => station.commandIdentity !== spec.identity)
  )
    throw new Error("Station belongs to another command.");
  const input = structuredClone(spec.input);
  const capabilities = spec.capabilities;
  const prepare: Prepare<Identity> = async (
    argv,
    context,
    runId,
    invocation,
    registration,
  ) => {
    const ready = await preflight(
      { ...spec, input },
      declaration,
      argv,
      context,
      registration,
      false,
    );
    if (!ready.ok) return ready;
    const { input: parsed, context: checked } = ready.value;
    return {
      ok: true,
      value: async () =>
        checkedResult(
          await spec.run(parsed, {
            ...checked,
            ...resultContext(declaration, runId, invocation),
          }),
          spec.identity,
          runId,
          invocation,
        ),
    };
  };
  const declaration = freeze({
    commandIdentity: spec.identity,
    route: [...spec.route],
    summary: spec.summary,
    effectClass: "inspect" as const,
    input,
    futureBindings: structuredClone(spec.futureBindings ?? {}),
    stations: structuredClone(spec.stations ?? []),
    capabilities: capabilities ?? {},
    execute: executeVia(prepare),
  });
  if (spec.programStopCause !== undefined)
    recordProgramStop(declaration, spec.programStopCause);
  requireProgramStopStation(declaration);
  return register(declaration, prepare);
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
        // The authority exclusion without approval (N6 a) stays runtime-only
        // here: the T3 specimen's typed handlers select from a union that
        // includes its declared-unreachable DOMAIN_AUTHORITY_REQUIRED.
      } & ResultContext<Identity, S, "repository-local" | "external">,
    ) => Promise<CommandResult<Identity>>;
  } & (C extends { readonly approval: true }
    ? {
        readonly approval: (input: ParsedInput<I>) => ApprovalRequest;
      }
    : { readonly approval?: never }),
) {
  freeze(spec);
  validateHostInput(spec.input);
  validateCommandIdentity(spec.identity);
  validateRootOperation(spec.route, spec.input);
  validateRouteTokens(spec.route);
  if (!isIssuedIfNoResult(spec.ifNoResult))
    throw new Error("ifNoResult must come from the state add-on descriptor.");
  admitChangingShape(spec);
  const prepare: Prepare<Identity> = async (
    argv,
    context,
    runId,
    invocation,
    registration,
  ) => {
    const ready = await preflight(
      spec,
      declaration,
      argv,
      context,
      registration,
      true,
    );
    if (!ready.ok) return ready;
    const { input: parsed, context: checked } = ready.value;
    return {
      ok: true,
      value: async (state) => {
        const entered = { ...checked, state };
        if (!stateContext(entered, spec.effects))
          return {
            ok: false,
            path: "capabilities",
            reason: "state unavailable",
          };
        return checkedResult(
          await spec.run(parsed, {
            ...entered,
            ...resultContext(declaration, runId, invocation),
          }),
          spec.identity,
          runId,
          invocation,
        );
      },
    };
  };
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
    execute: executeVia(prepare),
  });
  return register(declaration, prepare);
}
