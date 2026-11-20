import {
  command,
  commonCauses,
  contractFor,
  runProcess,
} from "agent-cli-kernel";

const status = command({
  identity: "approval.status",
  route: ["status"],
  summary: "Report that the CLI runs.",
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
      { commandIdentity: "approval.status", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Runs.",
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
    cli: "approval",
    commands: [status],
    causes: commonCauses,
    installedAddons: ["approval"],
  }),
)(process.argv.slice(2));
