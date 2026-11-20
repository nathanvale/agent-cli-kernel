import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  command,
  commonCauses,
  contractFor,
  runProcess,
  station,
} from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";

const causes = {
  ...commonCauses,
  DOMAIN_TARGET_UNKNOWN_NAME: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
} as const satisfies CauseTable;

const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const nothingChanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

const text = {
  kind: "string",
  minLength: 1,
  maxLength: 4096,
  choices: null,
  pattern: null,
} as const;

const status = command({
  identity: "target.status",
  route: ["status"],
  summary: "Report that the target runs.",
  input: noInput,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "target.status", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The target runs.",
        data: { ready: true },
        effects: nothingChanged,
      },
    ),
});

const hold = command({
  identity: "target.hold",
  route: ["hold"],
  summary: "Note a line in a ledger, then wait until a FIFO is written.",
  input: {
    ...noInput,
    arguments: [
      {
        name: "ledger",
        summary: "The ledger file.",
        required: true,
        value: text,
      },
      {
        name: "fifo",
        summary: "The FIFO to read.",
        required: true,
        value: text,
      },
    ],
  },
  capabilities: {},
  run: (input, context) => {
    appendFileSync(input.ledger, "holding\n");
    const read = readFileSync(input.fifo, "utf8");
    return context.result(
      { commandIdentity: "target.hold", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Released.", data: { read }, effects: nothingChanged },
    );
  },
});

const touch = command({
  identity: "target.touch",
  route: ["touch"],
  summary: "Write a file, though the command declares no change.",
  input: {
    ...noInput,
    arguments: [
      { name: "path", summary: "The file.", required: true, value: text },
    ],
  },
  capabilities: {},
  run: (input, context) => {
    writeFileSync(input.path, "touched");
    return context.result(
      { commandIdentity: "target.touch", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Touched.", data: null, effects: nothingChanged },
    );
  },
});

const name = command({
  identity: "target.name",
  route: ["name"],
  summary: "Accept the name known and refuse any other.",
  input: {
    ...noInput,
    arguments: [
      { name: "name", summary: "A name.", required: true, value: text },
    ],
  },
  capabilities: {},
  stations: [
    station(causes, {
      ...words,
      commandIdentity: "target.name",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The name is known.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "target.name:known",
    }),
    station(causes, {
      ...words,
      commandIdentity: "target.name",
      causeCode: "DOMAIN_TARGET_UNKNOWN_NAME",
      trigger: "The name is not known.",
      repairAction: "Use the name known.",
      guidance: { next: { kind: "instruction", text: "Use the name known." } },
      independentObservable: "target.name:unknown",
    }),
  ],
  run: (input, context) =>
    input.name === "known"
      ? context.result(
          { commandIdentity: "target.name", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Known.",
            data: { name: input.name },
            effects: nothingChanged,
          },
        )
      : context.result(
          {
            commandIdentity: "target.name",
            causeCode: "DOMAIN_TARGET_UNKNOWN_NAME",
          },
          {
            message: `No name ${input.name}.`,
            data: null,
            effects: nothingChanged,
          },
        ),
});

const contract = contractFor({
  cli: "target",
  commands: [status, hold, touch, name],
  causes,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
