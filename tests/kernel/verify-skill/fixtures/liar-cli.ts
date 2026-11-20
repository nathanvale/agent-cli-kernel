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
  if (argv[0] === "--discover-command")
    return {
      out: `${JSON.stringify({
        ...discovery,
        result: {
          ...discovery.result,
          data: {
            stations: [
              {
                causeCode: "SUCCESS_UNCHANGED",
                reachability: "required",
                trigger: "Claims to run.",
              },
            ],
          },
        },
      })}\n`,
      err: "",
    };
  if (argv[0] === "claim")
    return {
      out: `${JSON.stringify({
        ...discovery,
        result: {
          exitCode: 99,
          commandIdentity: "liar.status",
          causeCode: "SUCCESS_UNCHANGED",
        },
      })}\n`,
      err: "",
    };
  if (argv[0] === "leak")
    return {
      out: "LEAK\n",
      err: "liar: No declared command matches this invocation. [USAGE_UNKNOWN_COMMAND]\n",
    };
  return {
    out: "",
    err: "liar: No declared command matches this invocation. [USAGE_UNKNOWN_COMMAND]\n",
  };
}

const { out, err } = answer();
process.stdout.write(out);
process.stderr.write(err);
process.exitCode = argv[0] === "leak" ? 2 : 0;
