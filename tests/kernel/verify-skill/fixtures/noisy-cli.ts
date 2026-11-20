process.stderr.write(`warming cache ${String(process.pid)}\n`);
await import(["..", "src", "cli.ts"].join("/"));
