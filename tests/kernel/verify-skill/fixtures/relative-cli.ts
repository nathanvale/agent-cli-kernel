import { readFileSync } from "node:fs";
import {
  command,
  commonCauses,
  contractFor,
  runProcess,
} from "agent-cli-kernel";

const greeting = readFileSync("fixtures/greeting.txt", "utf8").trim();

const greet = command({
  identity: "relative.greet",
  route: ["greet"],
  summary: "Print the greeting read at start.",
  input: {
    arguments: [],
    options: [],
    constraints: [],
    deadlineSupported: false,
    additionalArguments: false,
    additionalOptions: false,
  },
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "relative.greet", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: greeting,
        data: null,
        effects: {
          completed: [],
          remaining: [],
          uncertain: [],
          inventoryComplete: true,
        },
      },
    ),
});

await runProcess(
  contractFor({
    cli: "relative",
    commands: [greet],
    causes: commonCauses,
    installedAddons: [],
  }),
)(process.argv.slice(2));
