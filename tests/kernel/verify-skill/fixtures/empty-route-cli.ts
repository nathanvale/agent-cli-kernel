import {
  command,
  commonCauses,
  contractFor,
  runProcess,
} from "agent-cli-kernel";

const greet = command({
  identity: "greeter.greet",
  route: [],
  summary: "Greet the name given.",
  input: {
    arguments: [
      {
        name: "name",
        summary: "Who to greet.",
        required: true,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 64,
          choices: null,
          pattern: null,
        },
      },
    ],
    options: [],
    constraints: [],
    deadlineSupported: false,
    additionalArguments: false,
    additionalOptions: false,
  },
  capabilities: {},
  run: (input, context) =>
    context.result(
      { commandIdentity: "greeter.greet", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: `Hello, ${input.name}.`,
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
    cli: "greeter",
    commands: [greet],
    causes: commonCauses,
    installedAddons: [],
  }),
)(process.argv.slice(2));
