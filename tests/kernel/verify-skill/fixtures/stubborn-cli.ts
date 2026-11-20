process.on("SIGTERM", () => undefined);
setTimeout(() => process.exit(0), 10_000);
