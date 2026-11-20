const ledger = process.argv[2] ?? "holder-ledger";
const held = Bun.spawn(["/bin/sleep", "20"], {
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
});
await Bun.write(ledger, `pid ${String(held.pid)}\n`);
held.unref();
process.exit(0);
