import { knownRoute } from "./state-seam.ts";
import type {
  IfNoResult,
  StateCapability,
  TransactionProof,
} from "./capabilities.ts";
import type { CapabilitySelection, HandlerContext } from "./capabilities.ts";
import type { InputSchema, ParsedInput } from "./input-types.ts";
import { parseInput } from "./input.ts";
import { inputSchema } from "./validation/input.ts";
import { handlerContext } from "./validation/context.ts";
import { text } from "./validation/primitives.ts";
import { freeze } from "./stations.ts";
import type { DeclaredStation } from "./stations.ts";
import type { JsonValue, Validation } from "./types.ts";
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
    readonly ifNoResult?: IfNoResult;
    readonly heldLockCause?: string;
    readonly unresolvedCaseCause?: string;
    readonly execute?: (
      argv: unknown,
      context: unknown,
    ) => Promise<Validation<JsonValue>>;
  };
export function command<
  const Identity extends string,
  const I extends InputSchema,
  const C extends CapabilitySelection = Record<never, never>,
>(spec: {
  readonly identity: Identity;
  readonly route: readonly string[];
  readonly summary: string;
  readonly input: I;
  readonly capabilities: C;
  readonly stations?: readonly DeclaredStation[];
  readonly run: (
    input: ParsedInput<I>,
    context: HandlerContext<C>,
  ) => JsonValue | Promise<JsonValue>;
}) {
  if (!inputSchema(spec.input))
    throw new Error("Invalid executable input declaration.");
  if (
    !text(spec.identity) ||
    new TextEncoder().encode(spec.identity).byteLength > 128 ||
    !text(spec.summary) ||
    spec.route.some((token) => !text(token) || token.startsWith("-"))
  )
    throw new Error("Invalid command declaration.");
  if (
    spec.stations?.some((station) => station.commandIdentity !== spec.identity)
  )
    throw new Error("Station belongs to another command.");
  const input = structuredClone(spec.input);
  const capabilities = spec.capabilities;
  return freeze({
    commandIdentity: spec.identity,
    route: [...spec.route],
    summary: spec.summary,
    effectClass: "inspect" as const,
    input,
    stations: structuredClone(spec.stations ?? []),
    capabilities: capabilities ?? {},
    async execute(
      argv: unknown,
      context: unknown,
    ): Promise<Validation<JsonValue>> {
      const parsed = await parseInput(input, argv);
      if (!parsed.ok) return parsed;
      if (!handlerContext(context, capabilities))
        return {
          ok: false,
          path: "capabilities",
          reason: "undeclared or unavailable capability",
        };
      return { ok: true, value: await spec.run(parsed.value, context) };
    },
  });
}

export function changing<
  const Identity extends string,
  const I extends InputSchema,
  const Effect extends string,
>(spec: {
  readonly identity: Identity;
  readonly route: readonly string[];
  readonly summary: string;
  readonly input: I;
  readonly effectClass: "repository-local" | "external";
  readonly effects: readonly [Effect, ...Effect[]];
  readonly ifNoResult: IfNoResult;
  readonly heldLockCause: string;
  readonly unresolvedCaseCause: string;
  readonly stations: readonly DeclaredStation[];
  readonly run: (
    input: ParsedInput<I>,
    context: { readonly state: StateCapability<Effect> },
  ) => Promise<TransactionProof<Effect>>;
}): CommandDeclaration<Identity> {
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
    !inputSchema(spec.input) ||
    spec.effects.length === 0 ||
    new Set(spec.effects).size !== spec.effects.length
  )
    throw new Error("Invalid changing declaration.");
  return freeze({
    commandIdentity: spec.identity,
    route: [...spec.route],
    summary: spec.summary,
    effectClass: spec.effectClass,
    effects: [...spec.effects],
    ifNoResult: spec.ifNoResult,
    heldLockCause: spec.heldLockCause,
    unresolvedCaseCause: spec.unresolvedCaseCause,
    input: structuredClone(spec.input),
    stations: structuredClone(spec.stations),
    capabilities: {},
  });
}
