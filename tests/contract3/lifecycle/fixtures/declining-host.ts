// LABELLED TEST-ONLY SCRIPT (F6). Runs the front door twice in one process
// through the kernel-internal runProcessOn with a host that declines to exit.
// A timer the front door failed to clear keeps this process alive (S1); a
// listener installed per run shows up in the listener counts (N7). Never
// registered as a production command; never ships.
import { appendFileSync } from "node:fs";
import {
  command,
  contractFor,
} from "../../../../starters/contract3/src/kernel/index.ts";
import { runProcessOn } from "../../../../starters/contract3/src/kernel/lifecycle.ts";
import { processHost } from "../../../../starters/contract3/src/kernel/process-host.ts";

const ledgerPath = process.env.FX_LEDGER ?? "/dev/null";
const ledger = (line: string) => appendFileSync(ledgerPath, `${line}\n`);

const quick = command({
  identity: "host.quick",
  route: ["quick"],
  summary: "Finish at once.",
  input: {
    arguments: [],
    options: [],
    constraints: [],
    deadlineSupported: true,
    additionalArguments: false,
    additionalOptions: false,
  },
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "host.quick", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Finished.",
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

const contract = contractFor({ cli: "host", commands: [quick] });
const real = processHost();
const declining = {
  ...real,
  exit(code: number) {
    ledger(`declined-exit ${code}`);
  },
};

for (let run = 0; run < 2; run++)
  await runProcessOn(
    contract,
    {},
    () => declining,
  )(["quick", "--deadline-ms", "60000", "--json"]);
ledger(
  `listeners ${["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]
    .map((name) => `${name}=${process.listenerCount(name)}`)
    .join(" ")}`,
);
