import { appendFileSync } from "node:fs";
import { contractFor, runProcess } from "../../../kernel/src/kernel/index.ts";
import { approvalAddon } from "./swarm-approval.ts";
import { inertState } from "./shapes.ts";
import { approvedRead, scenarios } from "./swarm-commands.ts";

const ledger = process.env.LEDGER ?? "";
const note = (line: string) => appendFileSync(ledger, `${line}\n`);
const [scenario = "", ...argv] = process.argv.slice(2);
if (scenario === "inspect-approval")
  await runProcess(
    contractFor({
      cli: "x",
      commands: [approvedRead(() => note("handler-entered"))],
      state: inertState("x"),
      installedAddons: ["state", "approval"],
    }),
    { addons: { approval: approvalAddon("x.read", note) } },
  )(argv);
else {
  const compose = scenarios[scenario];
  if (!compose) throw new Error(`Unknown scenario ${scenario}.`);
  await runProcess(compose(), {})(argv);
}
