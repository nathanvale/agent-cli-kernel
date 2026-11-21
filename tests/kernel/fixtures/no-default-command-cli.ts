import {
  command,
  commonCauses,
  contractFor,
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
  commands: [list],
});

await runProcess(contract)(process.argv.slice(2));
