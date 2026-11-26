const argv = process.argv.slice(2);
const lie = process.env.VERIFY_LIE ?? "";

type Answer = { out: string; err: string; exit: number };

function envelope(result: Record<string, unknown>, data: unknown = null) {
  return `${JSON.stringify({
    contractVersion: "3.0.0",
    message: "A liar's answer.",
    availablePaths: [],
    result: { ...result, data },
  })}\n`;
}

const listed = [
  {
    commandIdentity: "liar.command-discovery",
    route: ["--discover-command"],
    effectClass: "inspect",
  },
  {
    commandIdentity: "liar.discovery",
    route: ["--discover"],
    effectClass: "inspect",
  },
  { commandIdentity: "liar.dispatch", route: [], effectClass: "inspect" },
  { commandIdentity: "liar.help", route: ["--help"], effectClass: "inspect" },
  ...(lie === "discovery-lists-a-command"
    ? []
    : [
        {
          commandIdentity: "liar.status",
          route: ["status"],
          effectClass: "inspect",
        },
      ]),
];

const unknownLine =
  'liar: No declared command matches "--verify-cli-undeclared-option". [USAGE_UNKNOWN_COMMAND]\n';

function readyProbe(): Answer {
  return {
    out: lie === "usage-probe-stdout-empty" ? "stray\n" : "",
    err:
      lie === "usage-probe-one-stderr-line"
        ? `two lines\n${unknownLine}`
        : unknownLine,
    exit: lie === "usage-probe-exit" ? 1 : 2,
  };
}

function discovery(): Answer {
  const exit = lie === "discovery-exit" ? 1 : 0;
  return {
    out: envelope(
      {
        exitCode: lie === "discovery-one-envelope" ? 5 : exit,
        commandIdentity: "liar.discovery",
        causeCode: "SUCCESS_UNCHANGED",
      },
      { contractVersion: "3.0.0", commands: listed },
    ),
    err: lie === "discovery-stderr-empty" ? "warning\n" : "",
    exit,
  };
}

function commandDiscovery(): Answer {
  const exit = lie === "command-discovery-exit" ? 1 : 0;
  return {
    out: envelope(
      {
        exitCode: lie === "command-discovery-one-envelope" ? 5 : exit,
        commandIdentity: "liar.command-discovery",
        causeCode: "SUCCESS_UNCHANGED",
      },
      {
        input: { arguments: [], options: [] },
        stations: [
          {
            causeCode: "SUCCESS_UNCHANGED",
            reachability: "required",
            trigger: "Report the status.",
          },
          ...(lie === "usage-cause-is-declared"
            ? []
            : [
                {
                  causeCode: "USAGE_INVALID_INVOCATION",
                  reachability: "required",
                  trigger: "Kernel USAGE_INVALID_INVOCATION.",
                },
              ]),
        ],
      },
    ),
    err: "",
    exit,
  };
}

function usage(json: boolean): Answer {
  if (json) {
    const exit = lie === "usage-exit" ? 1 : 2;
    return {
      out: envelope({
        exitCode: lie === "usage-envelope-exit-equals-process-exit" ? 3 : exit,
        commandIdentity: "liar.status",
        causeCode:
          lie === "usage-cause-is-invalid-invocation"
            ? "SUCCESS_UNCHANGED"
            : "USAGE_INVALID_INVOCATION",
      }),
      err: lie === "usage-json-stderr-empty" ? "warning\n" : "",
      exit,
    };
  }
  const line = "liar: The option is not declared. [USAGE_INVALID_INVOCATION]\n";
  return {
    out: lie === "usage-human-stdout-empty" ? "stray\n" : "",
    err:
      lie === "usage-human-stderr-one-line-with-cause"
        ? `two lines\n${line}`
        : line,
    exit: lie === "usage-human-exit" ? 1 : 2,
  };
}

function status(): Answer {
  return {
    out: envelope({
      exitCode: lie === "run-envelope-exit-equals-process-exit" ? 4 : 0,
      commandIdentity:
        lie === "run-names-its-command" ? "liar.other" : "liar.status",
      causeCode:
        lie === "run-cause-is-declared" ? "SUCCESS_OTHER" : "SUCCESS_UNCHANGED",
    }),
    err: lie === "run-json-stderr-empty" ? "warning\n" : "",
    exit: 0,
  };
}

function answer(): Answer {
  const [first, second] = argv;
  if (first === "--help")
    return {
      out: lie === "help-usage-line" ? "Help for liar\n" : "Usage: liar\n",
      err: lie === "help-stderr-empty" ? "warning\n" : "",
      exit: lie === "help-exit" ? 1 : 0,
    };
  if (first === "--verify-cli-undeclared-option") return readyProbe();
  if (first === "--discover") return discovery();
  if (first === "--discover-command") return commandDiscovery();
  if (first === "status" && second === "--verify-cli-undeclared-option")
    return usage(argv.includes("--json"));
  if (first === "status" && second === "--help")
    return {
      out: "Usage: liar status\n",
      err: "",
      exit: lie === "command-help-exit" ? 1 : 0,
    };
  if (first === "status" && second === "--json") return status();
  return {
    out: lie === "unknown-command-stdout-empty" ? "stray\n" : "",
    err:
      lie === "unknown-command-stderr-one-line-with-cause"
        ? `two lines\n${unknownLine}`
        : unknownLine,
    exit: lie === "unknown-command-exit" ? 1 : 2,
  };
}

const { out, err, exit } = answer();
process.stdout.write(out);
process.stderr.write(err);
process.exitCode = exit;
