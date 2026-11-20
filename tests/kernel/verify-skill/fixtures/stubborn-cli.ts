import { appendFileSync } from "node:fs";

const ledger = process.argv[2] ?? "";
process.on("SIGTERM", () => appendFileSync(ledger, "sigterm\n"));
appendFileSync(ledger, "listening\n");
setTimeout(() => process.exit(0), 10_000);
