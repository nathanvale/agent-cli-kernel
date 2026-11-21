import { describe, expect, test } from "bun:test";
import {
  changing,
  command,
  contractFor,
  defaultCommandDisclosure,
  runInProcess,
  scriptedTerminal,
  station,
} from "../../../kernel/src/kernel/index.ts";
import { menuAddon } from "../../../kernel/src/addons/menu/index.ts";
import { stateAddon } from "../../../kernel/src/addons/state/index.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  emptyInput,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import { allCauses, baseStations, menuCauses } from "./menu-helpers.ts";

const folder = ownedFolders();

describe("menu start-up checks", () => {
  test("refuses a command declaring menu without notInteractiveCause", () => {
    expect(() =>
      command({
        identity: "doorway.menu",
        route: ["menu"],
        summary: "Show a menu.",
        input: emptyInput,
        capabilities: { menu: true },
        stations: baseStations("doorway.menu"),
        run: (_input, context) =>
          context.result(
            { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow("notInteractiveCause");
  });

  test("refuses a command whose notInteractiveCause is not a command-owned refused unchanged station", () => {
    expect(() =>
      command({
        identity: "doorway.menu",
        route: ["menu"],
        summary: "Show a menu.",
        input: emptyInput,
        capabilities: { menu: true },
        notInteractiveCause: "DOMAIN_DOORWAY_FAILED",
        stations: [
          ...baseStations("doorway.menu"),
          station(allCauses, {
            ...stationWords,
            commandIdentity: "doorway.menu",
            causeCode: "DOMAIN_DOORWAY_FAILED",
            trigger: "Failed.",
            repairAction: "Try again.",
            guidance: { next: { kind: "instruction", text: "Retry." } },
            independentObservable: "doorway.menu:failed",
          }),
        ],
        run: (_input, context) =>
          context.result(
            { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow("refused and unchanged");

    expect(() =>
      command({
        identity: "doorway.menu",
        route: ["menu"],
        summary: "Show a menu.",
        input: emptyInput,
        capabilities: { menu: true },
        notInteractiveCause: "DOMAIN_PRECONDITION_UNMET",
        stations: [
          ...baseStations("doorway.menu"),
          station(allCauses, {
            ...stationWords,
            commandIdentity: "doorway.menu",
            causeCode: "DOMAIN_PRECONDITION_UNMET",
            trigger: "Common cause.",
            repairAction: "Try again.",
            guidance: { next: { kind: "instruction", text: "Retry." } },
            independentObservable: "doorway.menu:common",
          }),
        ],
        run: (_input, context) =>
          context.result(
            { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow("command-owned cause");
  });

  test("refuses notInteractiveCause without capabilities.menu and refuses menu without installedAddons", () => {
    expect(() =>
      command({
        identity: "doorway.plain",
        route: ["plain"],
        summary: "Plain.",
        input: emptyInput,
        capabilities: {},
        notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
        stations: baseStations("doorway.plain"),
        run: (_input, context) =>
          context.result(
            {
              commandIdentity: "doorway.plain",
              causeCode: "SUCCESS_UNCHANGED",
            },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow("notInteractiveCause requires capabilities.menu");

    const menuCmd = command({
      identity: "doorway.menu",
      route: ["menu"],
      summary: "Show a menu.",
      input: emptyInput,
      capabilities: { menu: true },
      notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      stations: baseStations("doorway.menu"),
      run: (_input, context) =>
        context.result(
          { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
          { message: "Done.", data: null, effects: unchanged },
        ),
    });

    expect(() =>
      contractFor({
        cli: "doorway",
        commands: [menuCmd],
        causes: menuCauses,
      }),
    ).toThrow("Declared capability add-on is not installed.");
  });

  test("refuses an undeclared notInteractiveCause station, a station requiring run bindings, and a raw menu declaration", () => {
    expect(() =>
      command({
        identity: "doorway.menu",
        route: ["menu"],
        summary: "Show a menu.",
        input: emptyInput,
        capabilities: { menu: true },
        notInteractiveCause: "DOMAIN_DOORWAY_UNDECLARED",
        stations: baseStations("doorway.menu"),
        run: (_input, context) =>
          context.result(
            { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow("must declare its not-interactive station");

    expect(() =>
      command({
        identity: "doorway.menu",
        route: ["menu"],
        summary: "Show a menu.",
        input: emptyInput,
        capabilities: { menu: true },
        notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
        stations: [
          station(allCauses, {
            ...stationWords,
            commandIdentity: "doorway.menu",
            causeCode: "SUCCESS_UNCHANGED",
            trigger: "Picked.",
            repairAction: null,
            guidance: { next: { kind: "done" } },
            independentObservable: "doorway.menu:picked",
          }),
          station(allCauses, {
            ...stationWords,
            commandIdentity: "doorway.menu",
            causeCode: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
            trigger: "A terminal is required.",
            repairAction: "Run in a terminal.",
            guidance: {
              next: {
                kind: "command",
                command: "doorway.menu",
                args: ["{binding.target}"],
              },
            },
            independentObservable: "doorway.menu:needs-terminal",
          }),
        ],
        run: (_input, context) =>
          context.result(
            { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow("cannot require run bindings");

    const rawMenuCommand = {
      commandIdentity: "doorway.raw-menu",
      route: ["raw-menu"],
      summary: "Raw menu.",
      effectClass: "inspect" as const,
      input: emptyInput,
      stations: [...baseStations("doorway.raw-menu")],
      capabilities: { menu: true as const },
      notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      execute: () =>
        Promise.resolve({ ok: false as const, path: "result", reason: "raw" }),
    };
    expect(() =>
      contractFor({
        cli: "doorway",
        commands: [rawMenuCommand],
        causes: menuCauses,
        installedAddons: ["menu"],
      }),
    ).toThrow("must be built with command() or changing()");
  });

  test("refuses a changing command declaring menu without notInteractiveCause and accepts a valid one", async () => {
    const root = folder("menu-changing-");
    const descriptor = stateAddon({
      root,
      report: "doorway.pending",
    }).descriptor;
    const pending = command({
      identity: "doorway.pending",
      route: ["pending"],
      summary: "Inspect pending work.",
      input: emptyInput,
      capabilities: {},
      stations: [
        station(allCauses, {
          ...stationWords,
          commandIdentity: "doorway.pending",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Read.",
          repairAction: null,
          guidance: {
            next: { kind: "instruction", text: "Inspect listed cases." },
          },
          independentObservable: "doorway.pending:read",
        }),
      ],
      run: (_input, context) =>
        context.result(
          {
            commandIdentity: "doorway.pending",
            causeCode: "SUCCESS_UNCHANGED",
          },
          { message: "Pending.", data: null, effects: unchanged },
        ),
    });
    const handoff = {
      handoff: {
        owner: "operator",
        reason: "Coordination refused.",
        inspect: [{ kind: "command", command: "doorway.pending", args: [] }],
      },
    } as const;
    const changingStations = [
      station(allCauses, {
        ...stationWords,
        commandIdentity: "doorway.open",
        causeCode: "DOMAIN_DOORWAY_LOCK_HELD",
        trigger: "Lock held.",
        repairAction: "Inspect pending.",
        guidance: handoff,
        independentObservable: "doorway.open:lock",
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: "doorway.open",
        causeCode: "DOMAIN_DOORWAY_UNRESOLVED",
        trigger: "Unresolved.",
        repairAction: "Inspect pending.",
        guidance: handoff,
        independentObservable: "doorway.open:unresolved",
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: "doorway.open",
        causeCode: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
        trigger: "A terminal is required to show the menu.",
        repairAction: "Run doorway open in a terminal.",
        guidance: {
          next: { kind: "instruction", text: "Run interactively." },
        },
        independentObservable: "doorway.open:needs-terminal",
      }),
      station(allCauses, {
        ...stationWords,
        commandIdentity: "doorway.open",
        causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
        trigger: "Cancelled.",
        repairAction: "Run again.",
        guidance: {
          next: { kind: "instruction", text: "Choose a place." },
        },
        independentObservable: "doorway.open:cancelled",
      }),
    ] as const;

    expect(() =>
      changing({
        identity: "doorway.open",
        route: ["open"],
        summary: "Choose and open.",
        input: emptyInput,
        capabilities: { menu: true },
        effectClass: "repository-local",
        effects: ["doorway.open"],
        ifNoResult: descriptor.ifNoResult,
        heldLockCause: "DOMAIN_DOORWAY_LOCK_HELD",
        unresolvedCaseCause: "DOMAIN_DOORWAY_UNRESOLVED",
        stations: changingStations,
        run: async (_input, context) =>
          Promise.resolve(
            context.result(
              {
                commandIdentity: "doorway.open",
                causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
              },
              {
                message: "Nothing was opened.",
                data: null,
                effects: unchanged,
              },
            ),
          ),
      }),
    ).toThrow("notInteractiveCause");

    const openCmd = changing({
      identity: "doorway.open",
      route: ["open"],
      summary: `Choose and open. ${defaultCommandDisclosure}`,
      input: emptyInput,
      capabilities: { menu: true },
      notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      effectClass: "repository-local",
      effects: ["doorway.open"],
      ifNoResult: descriptor.ifNoResult,
      heldLockCause: "DOMAIN_DOORWAY_LOCK_HELD",
      unresolvedCaseCause: "DOMAIN_DOORWAY_UNRESOLVED",
      stations: changingStations,
      run: async (_input, context) => {
        const picked = await context.menu.show({
          lines: ["Open what?"],
          rows: [{ label: "alpha", value: "alpha" }],
        });
        if (picked.kind === "cancelled")
          return context.result(
            {
              commandIdentity: "doorway.open",
              causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
            },
            { message: "Nothing was opened.", data: null, effects: unchanged },
          );
        return context.result(
          {
            commandIdentity: "doorway.open",
            causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
          },
          { message: "Nothing was opened.", data: null, effects: unchanged },
        );
      },
    });
    const contract = contractFor({
      cli: "doorway",
      commands: [openCmd, pending],
      defaultCommand: openCmd,
      state: descriptor,
      causes: menuCauses,
      installedAddons: ["state", "menu"],
    });
    const cancelled = await runInProcess(contract, {
      addons: { menu: menuAddon() },
      terminal: scriptedTerminal(["\x1b"]),
    })(["open"]);
    expect(cancelled).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: {
        message: "Nothing was opened.",
        result: {
          commandIdentity: "doorway.open",
          causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
          outcome: "refused",
          transactionState: "unchanged",
        },
      },
    });
  });

  test("refuses a retryable notInteractiveCause at start-up", () => {
    const retryableCauses = {
      ...allCauses,
      DOMAIN_DOORWAY_RETRYABLE: {
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "transient",
        exitCode: 75,
        retryable: true,
        guidance: "next",
      },
    } as const;
    const retryableStations = [
      ...baseStations("doorway.menu"),
      station(retryableCauses, {
        ...stationWords,
        commandIdentity: "doorway.menu",
        causeCode: "DOMAIN_DOORWAY_RETRYABLE",
        trigger: "A terminal is required to show the menu.",
        repairAction: "Run in an interactive terminal.",
        guidance: { next: { kind: "retry" } },
        retryDelayPolicy: {
          kind: "bounded",
          minimumMilliseconds: 100,
          maximumMilliseconds: 500,
        },
        independentObservable: "doorway.menu:retryable",
      }),
    ] as const;

    expect(() =>
      command({
        identity: "doorway.menu",
        route: ["menu"],
        summary: "Show a menu.",
        input: emptyInput,
        capabilities: { menu: true },
        notInteractiveCause: "DOMAIN_DOORWAY_RETRYABLE",
        stations: retryableStations,
        run: (_input, context) =>
          context.result(
            { commandIdentity: "doorway.menu", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow(
      "doorway.menu's not-interactive station DOMAIN_DOORWAY_RETRYABLE cannot be retryable.",
    );
  });
});
