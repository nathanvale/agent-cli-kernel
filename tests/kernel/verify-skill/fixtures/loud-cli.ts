process.stderr.write(`${"deprecated: old flag syntax ".repeat(1200)}\n`);
await import(["..", "src", "cli.ts"].join("/"));
