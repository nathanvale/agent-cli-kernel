import {
  command,
  commonCauses,
  contractFor,
  defaultCommandDisclosure,
  runProcess,
} from "../../../kernel/src/kernel/index.ts";

const emptyInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: true,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const unchanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const menu = command({
  identity: "doorway.menu",
  route: ["menu"],
  summary: `Open the interactive menu. ${defaultCommandDisclosure}`,
  input: emptyInput,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      {
        commandIdentity: "doorway.menu",
        causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
      },
      { message: "Opened menu.", data: { opened: "menu" }, effects: unchanged },
    ),
});

const list = command({
  identity: "doorway.list",
  route: ["list"],
  summary: "List available places.",
  input: emptyInput,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      {
        commandIdentity: "doorway.list",
        causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
      },
      { message: "Listed places.", data: { places: [] }, effects: unchanged },
    ),
});

const contract = contractFor({
  cli: "doorway",
  commands: [menu, list],
  defaultCommand: menu,
});

await runProcess(contract)(process.argv.slice(2));
