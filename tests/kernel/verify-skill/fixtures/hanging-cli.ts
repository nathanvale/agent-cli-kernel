const ledger = process.argv[2] ?? "hanging-ledger";
const held = Bun.spawn(["/bin/sleep", "30"], {
  stdio: ["ignore", "ignore", "ignore"],
});
await Bun.write(ledger, `pid ${String(held.pid)}\n`);
setInterval(() => undefined, 1_000);
