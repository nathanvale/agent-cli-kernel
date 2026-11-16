// Test-owned process entry for the swarm-triage cases: argv is <scenario>
// then the CLI argv. It runs one scenario through the real process front door.
import { runProcess } from "../../../starters/contract3/src/kernel/index.ts";
import { scenarios } from "./swarm-commands.ts";

const [scenario = "", ...argv] = process.argv.slice(2);
const compose = scenarios[scenario];
if (!compose) throw new Error(`Unknown scenario ${scenario}.`);
await runProcess(compose(), {})(argv);
