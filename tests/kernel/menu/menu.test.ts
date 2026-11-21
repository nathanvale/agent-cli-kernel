import { describe, expect, jest, test } from "bun:test";
import {
  command,
  contractFor,
  runInProcess,
  scriptedTerminal,
} from "../../../kernel/src/kernel/index.ts";
import type { TerminalAdapter } from "../../../kernel/src/kernel/index.ts";
import { menuAddon } from "../../../kernel/src/addons/menu/index.ts";
import { emptyInput, unchanged } from "../kernel-repair/shapes.ts";
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
    await waiting.opened;
    let reentrantError = "";
    try {
      await attached.capability.show({
        lines: ["Second?"],
        rows: [{ label: "beta", value: "b" }],
      });
    } catch (error) {
      reentrantError = error instanceof Error ? error.message : String(error);
    }
    expect(reentrantError).toContain("already open");
    waiting.send("\r");
    expect(await first).toEqual({ kind: "picked", value: "a", index: 0 });

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
});
