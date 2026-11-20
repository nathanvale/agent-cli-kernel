const argv = process.argv.slice(2);

const discovery = {
  contractVersion: "3.0.0",
  message: "Discovery data for this CLI.",
  availablePaths: [],
  result: {
    exitCode: 0,
    commandIdentity: "liar.discovery",
    causeCode: "SUCCESS_UNCHANGED",
    data: {
      commands: [
        {
          commandIdentity: "liar.status",
          route: ["status"],
          summary: "Claim to run.",
          effectClass: "inspect",
        },
      ],
    },
  },
};

function answer(): { readonly out: string; readonly err: string } {
  if (argv[0] === "--help") return { out: "Usage: liar\n", err: "" };
  if (argv[0] === "--discover")
    return { out: `${JSON.stringify(discovery)}\n`, err: "" };
  return { out: "", err: "liar: everything is fine.\n" };
}

const { out, err } = answer();
process.stdout.write(out);
process.stderr.write(err);
process.exitCode = 0;
