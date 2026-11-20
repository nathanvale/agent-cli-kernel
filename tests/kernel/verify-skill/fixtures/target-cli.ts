import { appendFileSync, readFileSync } from "node:fs";
import {
  command,
  commonCauses,
  contractFor,
  runProcess,
} from "agent-cli-kernel";

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
    appendFileSync(input.ledger, `holding\npid ${String(process.pid)}\n`);
    const read = readFileSync(input.fifo, "utf8");
    return context.result(
      { commandIdentity: "target.hold", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Released.", data: { read }, effects: nothingChanged },
    );
  },
});

const where = command({
  identity: "target.where",
  route: ["where"],
  summary: "Print the folder the target runs in, then the word given.",
  input: {
    ...noInput,
    arguments: [
      { name: "word", summary: "Any word.", required: true, value: text },
    ],
  },
  capabilities: {},
  run: (input, context) =>
    context.result(
      { commandIdentity: "target.where", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: `${process.cwd()} ${input.word}`,
        data: null,
        effects: nothingChanged,
      },
    ),
});

const orphan = command({
  identity: "target.orphan",
  route: ["orphan"],
  summary: "Kill the process that started the target, then return.",
  input: {
    ...noInput,
    arguments: [
      {
        name: "confirm",
        summary: "Any word; a sweep never supplies one.",
        required: true,
        value: text,
      },
    ],
  },
  capabilities: {},
  run: (_input, context) => {
    process.kill(process.ppid, "SIGKILL");
    return context.result(
      { commandIdentity: "target.orphan", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Orphaned.", data: null, effects: nothingChanged },
    );
  },
});

const contract = contractFor({
  cli: "target",
  commands: [status, hold, where, orphan],
  causes: commonCauses,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
