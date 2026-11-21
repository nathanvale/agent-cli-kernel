import { describe, expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  command,
  contractFor,
  runInProcess,
  scriptedTerminal,
} from "../../../kernel/src/kernel/index.ts";
import type {
  MenuResult,
  TerminalAdapter,
} from "../../../kernel/src/kernel/index.ts";
import { ttyTerminalFor } from "../../../kernel/src/kernel/process-host.ts";
import type { TtyStream } from "../../../kernel/src/kernel/process-host.ts";
import { menuAddon } from "../../../kernel/src/addons/menu/index.ts";
import { emptyInput, unchanged } from "../kernel-repair/shapes.ts";
import { settledWithin } from "../kernel-repair/swarm-process.ts";
import {
  baseStations,
  menuCauses,
  normalizeRunId,
  singlePickContract,
  trackingTerminal,
  waitingTerminal,
} from "./menu-helpers.ts";

describe("menu in-process behaviour with scriptedTerminal", () => {
  test("picks a row with arrow navigation and restores the terminal", async () => {
    const terminal = trackingTerminal(["\x1b[B", "\r"]);
    const ran = await runInProcess(singlePickContract(), {
      addons: { menu: menuAddon() },
      terminal: terminal.adapter,
    })(["menu"]);
    expect(ran).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        message: "Picked val-beta.",
        result: {
          commandIdentity: "doorway.menu",
          causeCode: "SUCCESS_UNCHANGED",
          data: { value: "val-beta", index: 1 },
        },
      },
    });
    expect(terminal.events[0]).toBe("enter");
    expect(terminal.events.at(-1)).toBe("leave");
    expect(terminal.drawn[0]).toEqual([
      "Notice.",
      "Open what?",
      "Filter: ",
      "> alpha",
      "  beta",
      "  gamma",
    ]);
  });

  test("cancels on Esc, exits 3 with the command's own station, and restores the terminal", async () => {
    const terminal = trackingTerminal(["\x1b"]);
    const ran = await runInProcess(singlePickContract(), {
      addons: { menu: menuAddon() },
      terminal: terminal.adapter,
    })(["menu"]);
    expect(ran).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: {
        message: "Nothing was opened.",
        result: {
          commandIdentity: "doorway.menu",
          causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
          outcome: "refused",
          transactionState: "unchanged",
          data: null,
        },
      },
    });
    expect(terminal.events[0]).toBe("enter");
    expect(terminal.events.at(-1)).toBe("leave");
  });

  test("runs two picks in one command with other work between, restoring the terminal and clearing the filter between calls", async () => {
    const between: string[] = [];
    const terminal = trackingTerminal(["b", "\r", "\r"]);
    const cmd = command({
      identity: "doorway.pair",
      route: ["pair"],
      summary: "Pick twice.",
      input: emptyInput,
      capabilities: { menu: true },
      notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      stations: baseStations("doorway.pair"),
      run: async (_input, context) => {
        const first = await context.menu.show({
          lines: ["First pick:"],
          rows: [
            { label: "alpha", value: "a" },
            { label: "beta", value: "b" },
          ],
        });
        if (first.kind === "cancelled")
          return context.result(
            {
              commandIdentity: "doorway.pair",
              causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
            },
            { message: "Nothing was opened.", data: null, effects: unchanged },
          );
        between.push(
          `after-first:${first.value}:leaves=${String(terminal.events.filter((e) => e === "leave").length)}`,
        );
        const second = await context.menu.show({
          lines: ["Second pick:"],
          rows: [
            { label: "alpha-second", value: "a2" },
            { label: "beta-second", value: "b2" },
          ],
        });
        if (second.kind === "cancelled")
          return context.result(
            {
              commandIdentity: "doorway.pair",
              causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
            },
            { message: "Nothing was opened.", data: null, effects: unchanged },
          );
        return context.result(
          { commandIdentity: "doorway.pair", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: `Picked ${first.value} then ${second.value}.`,
            data: { first: first.value, second: second.value },
            effects: unchanged,
          },
        );
      },
    });
    const contract = contractFor({
      cli: "doorway",
      commands: [cmd],
      causes: menuCauses,
      installedAddons: ["menu"],
    });
    const ran = await runInProcess(contract, {
      addons: { menu: menuAddon() },
      terminal: terminal.adapter,
    })(["pair"]);
    expect(ran).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        result: { data: { first: "b", second: "a2" } },
      },
    });
    expect(between).toEqual(["after-first:b:leaves=1"]);
    expect(terminal.events.filter((e) => e === "enter")).toHaveLength(2);
    expect(terminal.events.filter((e) => e === "leave")).toHaveLength(2);
  });

  test("refuses not-interactive runs before handler entry, identically for no terminal and --json", async () => {
    let calls = 0;
    const contract = singlePickContract(() => {
      calls += 1;
    });
    const noTerminal = await runInProcess(contract, {
      addons: { menu: menuAddon() },
    })(["menu"]);
    const withJson = await runInProcess(contract, {
      addons: { menu: menuAddon() },
      terminal: scriptedTerminal(["\r"]),
    })(["menu", "--json"]);
    expect(calls).toBe(0);
    expect(noTerminal.kind).toBe("envelope");
    expect(withJson.kind).toBe("envelope");
    if (noTerminal.kind !== "envelope" || withJson.kind !== "envelope") return;
    expect(noTerminal.exitCode).toBe(3);
    expect(withJson.exitCode).toBe(3);
    expect(noTerminal.envelope.result.causeCode).toBe(
      "DOMAIN_DOORWAY_NEEDS_TERMINAL",
    );
    expect(normalizeRunId(JSON.stringify(noTerminal.envelope))).toBe(
      normalizeRunId(JSON.stringify(withJson.envelope)),
    );
  });

  test("strips control characters and bidirectional overrides from labels and lines before drawing", async () => {
    const terminal = trackingTerminal(["\r"]);
    const contract = singlePickContract(
      undefined,
      [{ label: "\x1b[2Jclean\x07\u202e", value: "v" }],
      ["\x1b[31mheader\u2066"],
    );
    const ran = await runInProcess(contract, {
      addons: { menu: menuAddon() },
      terminal: terminal.adapter,
    })(["menu"]);
    expect(ran).toMatchObject({ kind: "envelope", exitCode: 0 });
    expect(terminal.drawn[0]).toEqual(["header", "Filter: ", "> clean"]);
    for (const frame of terminal.drawn) {
      for (const line of frame) {
        expect(line.includes("\x1b")).toBe(false);
        expect(line.includes("\x07")).toBe(false);
        expect(line.includes("\u202e")).toBe(false);
        expect(line.includes("\u2066")).toBe(false);
      }
    }
  });

  test("refuses invalid request bounds before entering or drawing on the terminal", async () => {
    const cases: readonly [
      string,
      {
        readonly lines?: readonly string[];
        readonly rows: readonly {
          readonly label: string;
          readonly value: number;
        }[];
      },
      string,
    ][] = [
      ["zero rows", { rows: [] }, "1 and 1000 rows"],
      [
        "more than 1000 rows",
        {
          rows: Array.from({ length: 1001 }, (_, i) => ({
            label: `r${String(i)}`,
            value: i,
          })),
        },
        "1 and 1000 rows",
      ],
      [
        "label over 200 characters",
        { rows: [{ label: "x".repeat(201), value: 1 }] },
        "200 characters",
      ],
      [
        "more than 3 lines",
        {
          lines: ["a", "b", "c", "d"],
          rows: [{ label: "ok", value: 1 }],
        },
        "at most 3",
      ],
    ];
    for (const [, request, message] of cases) {
      const terminal = trackingTerminal(["\r"]);
      const addon = menuAddon().attach({
        runId: "r1",
        commandIdentity: "doorway.menu",
        summary: "Show a menu.",
        signal: new AbortController().signal,
        terminal: terminal.adapter,
      });
      let caught = "";
      try {
        await addon.capability.show(request);
      } catch (error) {
        caught = error instanceof Error ? error.message : String(error);
      }
      expect(caught).toContain(message);
      expect(terminal.events).toEqual([]);
      expect(terminal.drawn).toEqual([]);
    }
  });

  test("keeps the menu open with no timer while a fake clock advances one hour", async () => {
    jest.useFakeTimers();
    try {
      const waiting = waitingTerminal();
      const pending = runInProcess(singlePickContract(), {
        addons: { menu: menuAddon() },
        terminal: waiting.adapter,
      })(["menu"]);
      await waiting.opened;
      jest.advanceTimersByTime(3_600_000);
      expect(waiting.events).toEqual(["enter"]);
      waiting.send("\r");
      const ran = await pending;
      expect(ran).toMatchObject({
        kind: "envelope",
        exitCode: 0,
        envelope: {
          result: { data: { value: "val-alpha", index: 0 } },
        },
      });
      expect(waiting.events).toEqual(["enter", "leave"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("restores the terminal and returns DOMAIN_DEADLINE_UNCHANGED on --deadline-ms", async () => {
    const waiting = waitingTerminal();
    let showRejected = false;
    const cmd = command({
      identity: "doorway.menu",
      route: ["menu"],
      summary: "Show a menu.",
      input: { ...emptyInput, deadlineSupported: true },
      capabilities: { menu: true },
      notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      stations: baseStations("doorway.menu"),
      run: async (_input, context) => {
        try {
          await context.menu.show({
            lines: ["Open what?"],
            rows: [{ label: "alpha", value: "val-alpha" }],
          });
        } catch (error) {
          showRejected = true;
          throw error;
        }
        return context.result(
          { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
          { message: "Done.", data: null, effects: unchanged },
        );
      },
    });
    const contract = contractFor({
      cli: "doorway",
      commands: [cmd],
      causes: menuCauses,
      installedAddons: ["menu"],
    });
    const ran = await runInProcess(contract, {
      addons: { menu: menuAddon() },
      terminal: waiting.adapter,
    })(["menu", "--deadline-ms", "120"]);
    expect(ran).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: {
        result: {
          commandIdentity: "doorway.menu",
          causeCode: "DOMAIN_DEADLINE_UNCHANGED",
          transactionState: "unchanged",
        },
      },
    });
    expect(showRejected).toBe(true);
    expect(waiting.events).toEqual(["enter", "leave"]);

    let directSignal: AbortSignal | undefined;
    const directWaiting = waitingTerminal();
    const directAdapter: TerminalAdapter = {
      ...directWaiting.adapter,
      keys(signal) {
        directSignal = signal;
        return directWaiting.adapter.keys(signal);
      },
    };
    const directController = new AbortController();
    const directAttached = menuAddon().attach({
      runId: "r-run-abort",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: directController.signal,
      terminal: directAdapter,
    });
    const directShow = directAttached.capability.show({
      lines: ["Open what?"],
      rows: [{ label: "alpha", value: "a" }],
    });
    try {
      await directWaiting.opened;
      directController.abort();
      expect(directSignal?.aborted).toBe(true);
      let abortError = "";
      try {
        await directShow;
      } catch (error) {
        abortError = error instanceof Error ? error.message : String(error);
      }
      expect(abortError).toBe("The menu was aborted.");
      expect(directWaiting.events).toEqual(["enter", "leave"]);
    } finally {
      await directAttached.settle();
    }
  });

  test("does not attach listeners to process.stdin", async () => {
    const before = process.stdin.listenerCount("data");
    const ran = await runInProcess(singlePickContract(), {
      addons: { menu: menuAddon() },
      terminal: scriptedTerminal(["\r"]),
    })(["menu"]);
    expect(ran).toMatchObject({ kind: "envelope", exitCode: 0 });
    expect(process.stdin.listenerCount("data")).toBe(before);
  });

  test("refuses concurrent show calls, aborted runs before show, and missing terminal on direct attach", async () => {
    const waiting = waitingTerminal();
    const controller = new AbortController();
    const attached = menuAddon().attach({
      runId: "r-reentrant",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: controller.signal,
      terminal: waiting.adapter,
    });
    const first = attached.capability.show({
      lines: ["Open what?"],
      rows: [{ label: "alpha", value: "a" }],
    });
    try {
      await waiting.opened;
      const second = attached.capability.show({
        lines: ["Second?"],
        rows: [{ label: "beta", value: "b" }],
      });
      const secondOutcome = await Promise.race([
        second.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({
            kind: "rejected" as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
        Promise.resolve().then(() => ({ kind: "pending" as const })),
      ]);
      expect(secondOutcome).toEqual({
        kind: "rejected",
        message: "A menu is already open for this run.",
      });
      waiting.send("\r");
      expect(await first).toEqual({ kind: "picked", value: "a", index: 0 });
    } finally {
      controller.abort();
      await attached.settle();
    }

    controller.abort();
    const afterAbort = trackingTerminal(["\r"]);
    const abortedAttach = menuAddon().attach({
      runId: "r-aborted",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: controller.signal,
      terminal: afterAbort.adapter,
    });
    let abortedError = "";
    try {
      await abortedAttach.capability.show({
        rows: [{ label: "alpha", value: "a" }],
      });
    } catch (error) {
      abortedError = error instanceof Error ? error.message : String(error);
    }
    expect(abortedError).toContain("stopping");
    expect(afterAbort.events).toEqual([]);

    const noTerminalAttach = menuAddon().attach({
      runId: "r-no-terminal",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: new AbortController().signal,
    });
    let missingTerminalError = "";
    try {
      await noTerminalAttach.capability.show({
        rows: [{ label: "alpha", value: "a" }],
      });
    } catch (error) {
      missingTerminalError =
        error instanceof Error ? error.message : String(error);
    }
    expect(missingTerminalError).toContain("interactive run");
  });

  test("restores the terminal on settle when keys ignore abort and on handler draw failure", async () => {
    const events: string[] = [];
    let openedResolve: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      openedResolve = resolve;
    });
    const hangingAdapter: TerminalAdapter = {
      size: () => ({ columns: 80, rows: 24 }),
      enter() {
        events.push("enter");
      },
      leave() {
        events.push("leave");
      },
      draw(lines) {
        if (lines.length > 0) openedResolve?.();
      },
      keys() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
            };
          },
        };
      },
    };
    const controller = new AbortController();
    const attached = menuAddon().attach({
      runId: "r-settle",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: controller.signal,
      terminal: hangingAdapter,
    });
    void attached.capability.show({
      lines: ["Open what?"],
      rows: [{ label: "alpha", value: "a" }],
    });
    await opened;
    expect(events).toEqual(["enter"]);
    expect(await attached.settle()).toBe(true);
    expect(events).toEqual(["enter", "leave"]);

    const failEvents: string[] = [];
    const failingAdapter: TerminalAdapter = {
      size: () => ({ columns: 80, rows: 24 }),
      enter() {
        failEvents.push("enter");
      },
      leave() {
        failEvents.push("leave");
      },
      draw() {
        throw new Error("draw failed");
      },
      keys: () => scriptedTerminal([]).keys(new AbortController().signal),
    };
    const failRun = await runInProcess(singlePickContract(), {
      addons: { menu: menuAddon() },
      terminal: failingAdapter,
    })(["menu"]);
    expect(failRun).toMatchObject({ kind: "envelope", exitCode: 1 });
    expect(failEvents).toEqual(["enter", "leave"]);
  });

  test("closes showController and detaches tty listeners on settle, killNow, and draw failure", async () => {
    function openableTty(failAfterDraws?: number) {
      class StubTtyStream extends EventEmitter implements TtyStream {
        rawModes: boolean[] = [];
        setRawMode(mode: boolean) {
          this.rawModes.push(mode);
        }
        pause() {}
        resume() {}
        ref() {}
        unref() {}
      }
      const stream = new StubTtyStream();
      const base = ttyTerminalFor({
        size: () => ({ columns: 80, rows: 24 }),
        openStream: () => stream,
        write: () => {},
      });
      const events: string[] = [];
      let drawCount = 0;
      let capturedSignal: AbortSignal | undefined;
      let listeningResolve: (() => void) | undefined;
      const listening = new Promise<void>((resolve) => {
        listeningResolve = resolve;
      });
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
        draw(lines) {
          drawCount += 1;
          if (failAfterDraws !== undefined && drawCount >= failAfterDraws)
            throw new Error("draw failed");
          base.draw(lines);
        },
        keys(signal) {
          capturedSignal = signal;
          const iterable = base.keys(signal);
          return {
            [Symbol.asyncIterator]() {
              const iterator = iterable[Symbol.asyncIterator]();
              listeningResolve?.();
              return iterator;
            },
          };
        },
      };
      return {
        adapter,
        stream,
        events,
        listening,
        signal: () => capturedSignal,
      };
    }

    const settleTty = openableTty();
    const settleAttached = menuAddon().attach({
      runId: "r-settle-close",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: new AbortController().signal,
      terminal: settleTty.adapter,
    });
    const settleShow = settleAttached.capability.show({
      lines: ["Open what?"],
      rows: [{ label: "alpha", value: "a" }],
    });
    await settleTty.listening;
    expect(settleTty.stream.listenerCount("data")).toBe(1);
    expect(settleTty.signal()?.aborted).toBe(false);
    expect(await settleAttached.settle()).toBe(true);
    expect(settleTty.signal()?.aborted).toBe(true);
    expect(settleTty.stream.listenerCount("data")).toBe(0);
    expect(settleTty.events).toEqual(["enter", "leave"]);
    expect(await settleShow).toEqual({ kind: "cancelled" });

    const killTty = openableTty();
    const killAttached = menuAddon().attach({
      runId: "r-kill-close",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: new AbortController().signal,
      terminal: killTty.adapter,
    });
    const killShow = killAttached.capability.show({
      lines: ["Open what?"],
      rows: [{ label: "alpha", value: "a" }],
    });
    await killTty.listening;
    expect(killTty.stream.listenerCount("data")).toBe(1);
    expect(killTty.signal()?.aborted).toBe(false);
    killAttached.killNow();
    expect(killTty.signal()?.aborted).toBe(true);
    expect(killTty.stream.listenerCount("data")).toBe(0);
    expect(killTty.events).toEqual(["enter", "leave"]);
    expect(await killShow).toEqual({ kind: "cancelled" });

    const redrawFailTty = openableTty(2);
    const redrawAttached = menuAddon().attach({
      runId: "r-draw-fail",
      commandIdentity: "doorway.menu",
      summary: "Show a menu.",
      signal: new AbortController().signal,
      terminal: redrawFailTty.adapter,
    });
    const redrawShow = redrawAttached.capability.show({
      lines: ["Open what?"],
      rows: [{ label: "alpha", value: "a" }],
    });
    await redrawFailTty.listening;
    redrawFailTty.stream.emit("data", "a");
    let caught = "";
    try {
      await redrawShow;
    } catch (error) {
      caught = error instanceof Error ? error.message : String(error);
    }
    expect(caught).toBe("draw failed");
    expect(redrawFailTty.signal()?.aborted).toBe(true);
    expect(redrawFailTty.stream.listenerCount("data")).toBe(0);
    expect(redrawFailTty.events).toEqual(["enter", "leave"]);
  });

  test("handles split arrow sequences and split UTF-8 bytes across chunks", async () => {
    const splitArrow = trackingTerminal(["\x1b", "[B", "\r"]);
    const arrowRan = await runInProcess(singlePickContract(), {
      addons: { menu: menuAddon() },
      terminal: splitArrow.adapter,
    })(["menu"]);
    expect(arrowRan).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: { value: "val-beta", index: 1 },
        },
      },
    });

    const splitUtf8 = trackingTerminal([
      new Uint8Array([0xc3]),
      new Uint8Array([0xa9]),
      "\r",
    ]);
    const utf8Contract = singlePickContract(undefined, [
      { label: "alpha", value: "val-alpha" },
      { label: "caf\u00e9", value: "val-cafe" },
    ]);
    const utf8Ran = await runInProcess(utf8Contract, {
      addons: { menu: menuAddon() },
      terminal: splitUtf8.adapter,
    })(["menu"]);
    expect(utf8Ran).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: { value: "val-cafe", index: 1 },
        },
      },
    });
  });

  test("cancels on Esc and restores the terminal within a bound for an async-generator adapter", async () => {
    const events: string[] = [];
    let releaseWait: (() => void) | undefined;
    let menuResult: MenuResult<string> | undefined;
    const adapter: TerminalAdapter = {
      size: () => ({ columns: 80, rows: 24 }),
      enter() {
        events.push("enter");
      },
      leave() {
        events.push("leave");
      },
      draw() {},
      async *keys(signal) {
        yield new TextEncoder().encode("\x1b");
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const finish = () => {
            signal.removeEventListener("abort", finish);
            resolve();
          };
          releaseWait = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
      },
    };
    const pending = runInProcess(
      singlePickContract(undefined, undefined, undefined, (result) => {
        menuResult = result;
      }),
      {
        addons: { menu: menuAddon() },
        terminal: adapter,
      },
    )(["menu"]);
    try {
      const outcome = await settledWithin(pending, 500);
      expect(outcome).not.toBe("expired");
      if (outcome === "expired") return;
      expect(outcome).toMatchObject({
        kind: "envelope",
        exitCode: 3,
        envelope: {
          message: "Nothing was opened.",
          result: {
            commandIdentity: "doorway.menu",
            causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
            outcome: "refused",
            transactionState: "unchanged",
            data: null,
          },
        },
      });
      expect(menuResult).toEqual({ kind: "cancelled" });
      expect(events).toEqual(["enter", "leave"]);
    } finally {
      releaseWait?.();
      await settledWithin(pending, 500);
    }
  });
});
