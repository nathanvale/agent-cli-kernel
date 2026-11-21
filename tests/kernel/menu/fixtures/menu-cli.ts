import { renameSync, writeFileSync } from "node:fs";
import {
  command,
  commonCauses,
  contractFor,
  defaultCommandDisclosure,
  runProcess,
  station,
} from "../../../../kernel/src/kernel/index.ts";
import type { CauseTable } from "../../../../kernel/src/kernel/index.ts";
import { menuAddon } from "../../../../kernel/src/addons/menu/index.ts";
import {
  emptyInput,
  stationWords,
  unchanged,
} from "../../kernel-repair/shapes.ts";
import { pickFromMenu } from "../menu-helpers.ts";

const causes = {
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
} as const satisfies CauseTable;

const allCauses = { ...commonCauses, ...causes };

const pick = command({
  identity: "doorway.menu",
  route: ["menu"],
  summary: `Ask which place to open. ${defaultCommandDisclosure}`,
  input: { ...emptyInput, deadlineSupported: true },
  capabilities: { menu: true },
  notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
  stations: [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.menu",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "A place was chosen.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "doorway.menu:picked",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.menu",
      causeCode: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      trigger: "A terminal is required to show the menu.",
      repairAction: "Run doorway menu in an interactive terminal.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Run in a terminal without --json.",
        },
      },
      independentObservable: "doorway.menu:needs-terminal",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.menu",
      causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
      trigger: "The menu was cancelled.",
      repairAction: "Run doorway menu again to choose a place.",
      guidance: {
        next: { kind: "instruction", text: "Choose a place when ready." },
      },
      independentObservable: "doorway.menu:cancelled",
    }),
  ],
  run: async (_input, context) =>
    pickFromMenu(context, {
      commandIdentity: "doorway.menu",
      lines: ["Open what?"],
      rows: [
        { label: "alpha", value: { name: "alpha" } },
        { label: "beta", value: { name: "beta" } },
      ],
      onPicked: (value, index) => ({
        message: `Opened ${value.name}.`,
        data: { place: value.name, index },
      }),
    }),
});

const twoStep = command({
  identity: "doorway.two-step",
  route: ["two-step"],
  summary: "Pick a host and then pick a place.",
  input: { ...emptyInput, deadlineSupported: true },
  capabilities: { menu: true },
  notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
  stations: [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.two-step",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Both choices were made.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "doorway.two-step:picked",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.two-step",
      causeCode: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      trigger: "A terminal is required to show the menu.",
      repairAction: "Run doorway two-step in an interactive terminal.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Run in a terminal without --json.",
        },
      },
      independentObservable: "doorway.two-step:needs-terminal",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.two-step",
      causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
      trigger: "A menu was cancelled.",
      repairAction: "Run doorway two-step again.",
      guidance: {
        next: { kind: "instruction", text: "Choose both items." },
      },
      independentObservable: "doorway.two-step:cancelled",
    }),
  ],
  run: async (_input, context) => {
    const first = await context.menu.show({
      lines: ["Step one?"],
      rows: [
        { label: "mac", value: "mac" },
        { label: "linux", value: "linux" },
      ],
    });
    if (first.kind === "cancelled")
      return context.result(
        {
          commandIdentity: "doorway.two-step",
          causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
        },
        { message: "Nothing was opened.", data: null, effects: unchanged },
      );
    const second = await context.menu.show({
      lines: [`Step two on ${first.value}?`],
      rows: [
        { label: "repo-one", value: "repo-one" },
        { label: "repo-two", value: "repo-two" },
      ],
    });
    if (second.kind === "cancelled")
      return context.result(
        {
          commandIdentity: "doorway.two-step",
          causeCode: "DOMAIN_DOORWAY_NOTHING_CHOSEN",
        },
        { message: "Nothing was opened.", data: null, effects: unchanged },
      );
    return context.result(
      { commandIdentity: "doorway.two-step", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: `Opened ${first.value}:${second.value}.`,
        data: { first: first.value, second: second.value },
        effects: unchanged,
      },
    );
  },
});

const crashWhileOpen = command({
  identity: "doorway.crash",
  route: ["crash"],
  summary: "Open a menu and crash on SIGUSR1 to test terminal restoration.",
  input: emptyInput,
  capabilities: { menu: true },
  notInteractiveCause: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
  stations: [
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.crash",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Completed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "doorway.crash:done",
    }),
    station(allCauses, {
      ...stationWords,
      commandIdentity: "doorway.crash",
      causeCode: "DOMAIN_DOORWAY_NEEDS_TERMINAL",
      trigger: "A terminal is required to show the menu.",
      repairAction: "Run doorway crash in an interactive terminal.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Run in a terminal without --json.",
        },
      },
      independentObservable: "doorway.crash:needs-terminal",
    }),
  ],
  run: async (_input, context) => {
    process.once("SIGUSR1", () => {
      throw new Error("uncaught-during-menu");
    });
    await context.menu.show({
      lines: ["Open what?"],
      rows: [{ label: "alpha", value: "alpha" }],
    });
    return context.result(
      { commandIdentity: "doorway.crash", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Done.", data: null, effects: unchanged },
    );
  },
});

const contract = contractFor({
  cli: "doorway",
  commands: [pick, twoStep, crashWhileOpen],
  defaultCommand: pick,
  causes,
  installedAddons: ["menu"],
});

const pidFile = process.env.MENU_CLI_PID_FILE;
if (pidFile) {
  const tmpFile = `${pidFile}.${String(process.pid)}.tmp`;
  writeFileSync(tmpFile, String(process.pid), "utf8");
  renameSync(tmpFile, pidFile);
}

await runProcess(contract, { addons: { menu: menuAddon() } })(
  process.argv.slice(2),
);
