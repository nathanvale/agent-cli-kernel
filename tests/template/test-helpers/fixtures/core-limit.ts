import { turnCoreDumpsOff } from "../../../support/abort.ts";

if (process.argv[2] === "off") turnCoreDumpsOff();
const read = Bun.spawnSync(["sh", "-c", "ulimit -c"]);
process.stdout.write(read.stdout.toString().trim());
