import type {
  AttachedAddon,
  MenuCapability,
  MenuResult,
  MenuRow,
  RunAddon,
  RunControl,
  TerminalAdapter,
} from "../../kernel/index.ts";
import {
  createKeyByteParser,
  createMenuState,
  renderMenu,
  stepMenu,
  waitForAbort,
} from "./list.ts";
import type {
  KeyByteParser,
  MenuKey,
  MenuState,
  MenuStepResult,
} from "./list.ts";

export type {
  MenuCapability,
  MenuResult,
  MenuRow,
} from "../../kernel/index.ts";

const maxLines = 3;
const maxRows = 1000;
const maxLabelLength = 200;
const escapeFlushMilliseconds = 50;
const iteratorCloseMilliseconds = 1_000;

type CheckedMenuRequest<Value> = {
  readonly lines: readonly string[];
  readonly rows: readonly MenuRow<Value>[];
};

function readLines(raw: unknown): readonly string[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw))
    throw new Error("A menu's lines must be an array of at most 3 strings.");
  const length = raw.length;
  if (length > maxLines)
    throw new Error(`A menu accepts at most ${String(maxLines)} header lines.`);
  const snapshot: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item: unknown = raw[index];
    if (typeof item !== "string")
      throw new Error("A menu's lines must be an array of at most 3 strings.");
    snapshot.push(item);
  }
  return Object.freeze(snapshot);
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function readRow<Value>(entry: MenuRow<Value> | undefined): MenuRow<Value> {
  if (typeof entry !== "object" || entry === null)
    throw new Error("Each menu row must carry a string label and a value.");
  const label: unknown = Object.hasOwn(entry, "label")
    ? Reflect.get(entry, "label")
    : undefined;
  if (typeof label !== "string")
    throw new Error("Each menu row must carry a string label and a value.");
  if (label.length > maxLabelLength)
    throw new Error(
      `A menu row label is at most ${String(maxLabelLength)} characters.`,
    );
  return Object.freeze({ label, value: entry.value });
}

function readRows<Value>(
  raw: readonly MenuRow<Value>[],
): readonly MenuRow<Value>[] {
  if (!isArrayValue(raw))
    throw new Error(`A menu requires between 1 and ${String(maxRows)} rows.`);
  const length = raw.length;
  if (length === 0 || length > maxRows)
    throw new Error(`A menu requires between 1 and ${String(maxRows)} rows.`);
  const snapshot: MenuRow<Value>[] = [];
  for (let index = 0; index < length; index += 1) {
    snapshot.push(readRow(raw[index]));
  }
  return Object.freeze(snapshot);
}

function checkedRequest<Value>(request: {
  readonly lines?: readonly string[];
  readonly rows: readonly MenuRow<Value>[];
}): CheckedMenuRequest<Value> {
  if (typeof request !== "object" || request === null)
    throw new Error("A menu request must be an object.");
  const rawLines: unknown = Object.hasOwn(request, "lines")
    ? Reflect.get(request, "lines")
    : undefined;
  const lines = readLines(rawLines);
  const rows = readRows(request.rows);
  return Object.freeze({ lines, rows });
}

function applyKeys<Value>(
  initial: MenuState<Value>,
  keys: readonly MenuKey[],
  signal: AbortSignal,
): {
  readonly state: MenuState<Value>;
  readonly result?: MenuStepResult<Value>;
} {
  let state = initial;
  for (const key of keys) {
    if (signal.aborted) break;
    const stepped = stepMenu(state, key);
    state = stepped.state;
    if (stepped.result !== undefined) return { state, result: stepped.result };
  }
  return { state };
}

type ReadEvent =
  | { readonly kind: "chunk"; readonly next: IteratorResult<Uint8Array> }
  | { readonly kind: "flush" };

async function raceTimeout<Result>(
  work: Promise<Result>,
  milliseconds: number,
  fallback: Result,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Result>((resolve) => {
    timer = setTimeout(() => resolve(fallback), milliseconds);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextWithEscapeFlush(
  pending: Promise<IteratorResult<Uint8Array>>,
  armEscapeTimer: boolean,
): Promise<ReadEvent> {
  const chunkEvent = pending.then(
    (next): ReadEvent => ({ kind: "chunk", next }),
  );
  if (!armEscapeTimer) return await chunkEvent;
  return await raceTimeout(chunkEvent, escapeFlushMilliseconds, {
    kind: "flush",
  });
}

function startIteratorReturn(
  iterator: AsyncIterator<Uint8Array>,
): Promise<void> | undefined {
  try {
    const closing = iterator.return?.();
    if (closing === undefined) return undefined;
    return Promise.resolve(closing).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return undefined;
  }
}

async function closeIterator(
  iterator: AsyncIterator<Uint8Array>,
): Promise<void> {
  const settled = startIteratorReturn(iterator);
  if (settled === undefined) return;
  await raceTimeout(settled, iteratorCloseMilliseconds, undefined);
}

async function* keyBatches(
  terminal: TerminalAdapter,
  signal: AbortSignal,
  parser: KeyByteParser,
  abortShow: () => void,
): AsyncIterable<{
  readonly keys: readonly MenuKey[];
  readonly redraw: boolean;
}> {
  const iterator = terminal.keys(signal)[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<Uint8Array>> | undefined;
  try {
    for (;;) {
      pending ??= iterator.next();
      const event = await nextWithEscapeFlush(
        pending,
        parser.hasPendingEscape(),
      );
      if (event.kind === "flush") {
        yield { keys: parser.flush(), redraw: false };
        continue;
      }
      pending = undefined;
      if (event.next.done) return;
      const keys = parser.push(event.next.value);
      yield { keys, redraw: keys.length > 0 };
    }
  } finally {
    void pending?.catch(() => undefined);
    abortShow();
    await closeIterator(iterator);
  }
}

async function interruptMenu(
  restore: () => void,
  signal: AbortSignal,
): Promise<never> {
  restore();
  process.kill(process.pid, "SIGINT");
  await waitForAbort(signal);
  throw new Error("The menu was interrupted.");
}

function attachMenu(run: RunControl): AttachedAddon<MenuCapability> {
  let active = false;
  let drew = false;
  let resizeListener: (() => void) | undefined;
  let activeShowController: AbortController | undefined;

  function abortActiveShow(): void {
    const controller = activeShowController;
    activeShowController = undefined;
    controller?.abort();
  }

  function restore(): void {
    if (!active) return;
    active = false;
    const listener = resizeListener;
    resizeListener = undefined;
    if (listener) process.off("SIGWINCH", listener);
    const terminal = run.terminal;
    if (!terminal) return;
    const hadDrawing = drew;
    drew = false;
    if (hadDrawing) ignoreClosedTerminal(() => terminal.draw([]));
    ignoreClosedTerminal(() => terminal.leave());
  }

  function terminalForShow(): TerminalAdapter {
    const terminal = run.terminal;
    if (!terminal)
      throw new Error("The menu add-on requires an interactive run.");
    if (run.signal.aborted)
      throw new Error("The run is stopping; no menu opens.");
    if (active) throw new Error("A menu is already open for this run.");
    return terminal;
  }

  async function resolveStep<Value>(
    result: MenuStepResult<Value>,
  ): Promise<MenuResult<Value>> {
    if (result.kind === "interrupt")
      return await interruptMenu(restore, run.signal);
    return result;
  }

  async function consumeKeys<Value>(
    session: { state: MenuState<Value> },
    keys: readonly MenuKey[],
  ): Promise<MenuResult<Value> | undefined> {
    const applied = applyKeys(session.state, keys, run.signal);
    session.state = applied.state;
    return applied.result === undefined
      ? undefined
      : await resolveStep(applied.result);
  }

  async function readLoop<Value>(
    terminal: TerminalAdapter,
    session: { state: MenuState<Value> },
    signal: AbortSignal,
    redraw: () => void,
  ): Promise<MenuResult<Value>> {
    const parser = createKeyByteParser();
    for await (const batch of keyBatches(
      terminal,
      signal,
      parser,
      abortActiveShow,
    )) {
      const finished = await consumeKeys(session, batch.keys);
      if (finished !== undefined) return finished;
      if (run.signal.aborted) break;
      if (batch.redraw) redraw();
    }
    if (run.signal.aborted) throw new Error("The menu was aborted.");
    return (
      (await consumeKeys(session, parser.flush())) ?? { kind: "cancelled" }
    );
  }

  function ignoreClosedTerminal(action: () => void): void {
    try {
      action();
    } catch {
      return;
    }
  }

  // Accepted decision (Nathan, 21 November 2026, 11:42; MAG-138 decision 21):
  // "Menus only" departs from LIFE-2a's first sentence solely in an interactive
  // run; LIFE-2a's second sentence (never prompt without a terminal) holds.
  async function show<Value>(request: {
    readonly lines?: readonly string[];
    readonly rows: readonly MenuRow<Value>[];
  }): Promise<MenuResult<Value>> {
    const checked = checkedRequest(request);
    const terminal = terminalForShow();
    const session = { state: createMenuState(checked.lines, checked.rows) };
    const showController = new AbortController();
    activeShowController = showController;
    const onRunAbort = () => {
      showController.abort();
    };
    run.signal.addEventListener("abort", onRunAbort, { once: true });

    const redraw = () => {
      if (!active) return;
      terminal.draw(renderMenu(session.state, terminal.size()));
      drew = true;
    };

    const onResize = () => {
      ignoreClosedTerminal(redraw);
    };

    active = true;
    drew = false;
    resizeListener = onResize;
    try {
      terminal.enter();
      process.on("SIGWINCH", onResize);
      redraw();
      return await readLoop(terminal, session, showController.signal, redraw);
    } finally {
      run.signal.removeEventListener("abort", onRunAbort);
      if (activeShowController === showController)
        activeShowController = undefined;
      showController.abort();
      restore();
    }
  }

  const capability: MenuCapability = Object.freeze({ show });

  return {
    capability,
    settle() {
      abortActiveShow();
      restore();
      return Promise.resolve(true);
    },
    killNow() {
      abortActiveShow();
      restore();
    },
  };
}

export function menuAddon(): RunAddon<MenuCapability> {
  return { attach: attachMenu };
}
