import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bunSpawn,
  defaultLimits,
  forwardStops,
} from "../../../../skills/verify-cli/verify.ts";

const ledger = process.argv[2] ?? "stop-ledger";
const limits = { ...defaultLimits, graceMilliseconds: 300 };
forwardStops(limits);
const started = performance.now();
const running = bunSpawn(process.env, limits)(
  [join(import.meta.dir, "stubborn-cli.ts"), ledger],
  import.meta.dir,
  60_000,
);
const listening = setInterval(() => {
  let text: string;
  try {
    text = readFileSync(ledger, "utf8");
  } catch {
    return;
  }
  if (text.split("\n").includes("listening")) {
    clearInterval(listening);
    process.kill(process.pid, "SIGTERM");
  }
}, 5);
const ran = await running;
process.stdout.write(
  `${JSON.stringify({ signal: ran.signal, milliseconds: Math.round(performance.now() - started) })}\n`,
);
process.exit(0);
