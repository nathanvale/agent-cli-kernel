const argv = process.argv.slice(2);
const runId = () => crypto.randomUUID();

if (argv.join(" ") === "--discover --json") {
  const envelope = {
    contractVersion: "3.0.0",
    message: "Commands.",
    result: {
      runId: runId(),
      exitCode: 0,
      commandIdentity: "nested.discovery",
      causeCode: "SUCCESS_UNCHANGED",
      data: {
        commands: [
          {
            commandIdentity: "nested.help",
            route: ["--help"],
            effectClass: "inspect",
          },
          {
            commandIdentity: "nested.go",
            route: ["go"],
            effectClass: "inspect",
            lastRun: { runId: runId() },
          },
        ],
      },
    },
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} else {
  process.stderr.write("nested: Unknown option. [USAGE_INVALID_INVOCATION]\n");
  process.exitCode = 2;
}
