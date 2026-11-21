import {
  command,
  commonCauses,
  contractFor,
  scriptedTerminal,
  station,
} from "../../../kernel/src/kernel/index.ts";
import type {
  CauseTable,
  CommandResult,
  JsonValue,
  MenuCapability,
  MenuRow,
  ResultContext,
  TerminalAdapter,
} from "../../../kernel/src/kernel/index.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";

export const menuCauses = {
  DOMAIN_DOORWAY_NEEDS_TERMINAL: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_DOORWAY_NOTHING_CHOSEN: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_DOORWAY_FAILED: {
    outcome: "failed",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_DOORWAY_LOCK_HELD: refusedHandoff,
  DOMAIN_DOORWAY_UNRESOLVED: refusedHandoff,
} as const satisfies CauseTable;

export const allCauses = { ...commonCauses, ...menuCauses };

export function baseStations<const Identity extends string>(
  identity: Identity,
) {
  return [
    station(allCauses, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "A choice was made.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: `${identity}:picked`,
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      trigger: "A terminal is required to show the menu.",
      repairAction: "Run in an interactive terminal.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Run in a terminal without --json.",
        },
      },
      independentObservable: `${identity}:needs-terminal`,
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: identity,
      causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
      trigger: "Nothing was chosen.",
      repairAction: "Run the command again.",
      guidance: {
        next: { kind: "instruction", text: "Choose a row when ready." },
      },
      independentObservable: `${identity}:cancelled`,
    }),
  ] as const;
}

export function trackingTerminal(
  keys: readonly (string | Uint8Array)[],
  dimensions = { columns: 80, rows: 24 },
) {
  const base = scriptedTerminal(keys, dimensions);
  const events: string[] = [];
  const adapter: TerminalAdapter = {
    size: () => base.size(),
    enter() {
      events.push("enter");
      base.enter();
    },
    leave() {
      events.push("leave");
      base.leave();
    },
    keys: (signal) => base.keys(signal),
    draw(lines) {
      events.push(`draw:${String(lines.length)}`);
      base.draw(lines);
    },
  };
  return { adapter, events, drawn: base.drawn };
}

export function waitingTerminal() {
  const events: string[] = [];
  const drawn: (readonly string[])[] = [];
  let push: ((chunk: Uint8Array) => void) | undefined;
  let openedResolve: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    openedResolve = resolve;
  });
  const adapter: TerminalAdapter = {
    size: () => ({ columns: 80, rows: 24 }),
    enter() {
      events.push("enter");
    },
    leave() {
      events.push("leave");
    },
    draw(lines) {
      drawn.push([...lines]);
      if (lines.length > 0) openedResolve?.();
    },
    keys(signal) {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (signal.aborted)
                return Promise.resolve({
                  done: true as const,
                  value: undefined,
                });
              return new Promise<IteratorResult<Uint8Array>>((resolve) => {
                const onAbort = () => {
                  push = undefined;
                  resolve({ done: true, value: undefined });
                };
                signal.addEventListener("abort", onAbort, { once: true });
                push = (chunk) => {
                  signal.removeEventListener("abort", onAbort);
                  push = undefined;
                  resolve({ done: false, value: chunk });
                };
              });
            },
            return() {
              push = undefined;
              return Promise.resolve({ done: true as const, value: undefined });
            },
          };
        },
      };
    },
  };
  return {
    adapter,
    events,
    drawn,
    opened,
    send(text: string) {
      push?.(new TextEncoder().encode(text));
    },
  };
}

export function normalizeRunId(jsonText: string): string {
  const parsed: unknown = JSON.parse(jsonText);
  if (typeof parsed !== "object" || parsed === null) return jsonText;
  const result: unknown = Reflect.get(parsed, "result");
  if (typeof result === "object" && result !== null)
    Reflect.set(result, "runId", "<runId>");
  return JSON.stringify(parsed);
}

export async function pickFromMenu<const Identity extends string, Value>(
  context: {
    readonly menu: MenuCapability;
    readonly result: ResultContext<
      Identity,
      ReturnType<typeof baseStations<Identity>>,
      "inspect",
      { readonly menu: true }
    >["result"];
  },
  options: {
    readonly commandIdentity: Identity;
    readonly lines?: readonly string[];
    readonly rows: readonly MenuRow<Value>[];
    readonly onPicked: (
      value: Value,
      index: number,
    ) => { readonly message: string; readonly data: JsonValue };
  },
): Promise<CommandResult<Identity>> {
  const picked = await context.menu.show(
    options.lines === undefined
      ? { rows: options.rows }
      : { lines: options.lines, rows: options.rows },
  );
  if (picked.kind === "cancelled")
    return context.result(
      {
        commandIdentity: options.commandIdentity,
        causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
      },
      { message: "Nothing was opened.", data: null, effects: unchanged },
    );
  const chosen = options.onPicked(picked.value, picked.index);
  return context.result(
    {
      commandIdentity: options.commandIdentity,
      causeCode: "SUCCESS_UNCHANGED",
    },
    { message: chosen.message, data: chosen.data, effects: unchanged },
  );
}

export function singlePickContract(
  onEnter?: () => void,
  rows: readonly { readonly label: string; readonly value: string }[] = [
    { label: "alpha", value: "val-alpha" },
    { label: "beta", value: "val-beta" },
    { label: "gamma", value: "val-gamma" },
  ],
  lines: readonly string[] = ["Notice.", "Open what?"],
) {
  const cmd = command({
    identity: "doorway.menu",
    route: ["menu"],
    summary: "Show a menu.",
    input: { ...emptyInput, deadlineSupported: true },
    capabilities: { menu: true },
    notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
    stations: baseStations("doorway.menu"),
    run: async (_input, context) => {
      onEnter?.();
      return pickFromMenu(context, {
        commandIdentity: "doorway.menu",
        lines,
        rows,
        onPicked: (value, index) => ({
          message: `Picked ${value}.`,
          data: { value, index },
        }),
      });
    },
  });
  return contractFor({
    cli: "doorway",
    commands: [cmd],
    causes: menuCauses,
    installedAddons: ["menu"],
  });
}
