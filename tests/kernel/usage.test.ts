import { describe, expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../kernel/src/kernel/index.ts";
import type { InputSchema } from "../../kernel/src/kernel/index.ts";
import { renderHuman } from "../../kernel/src/kernel/human.ts";
import { runInProcessOn } from "../../kernel/src/kernel/lifecycle.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";
import { emptyInput, repairWords, unchanged } from "./kernel-repair/shapes.ts";
import {
  bareList,
  pairShow,
  slotShow,
} from "./kernel-repair/swarm-commands.ts";
import {
  entry,
  processWatchdog,
  spawnBounded,
} from "./kernel-repair/swarm-process.ts";
import { recordingHost } from "./lifecycle/recording-host.ts";

const usage = "USAGE_INVALID_INVOCATION";
const helpStep = { kind: "command", command: "x.help", args: [] } as const;
const bare = "No command was given. Run x --help to list the commands.";
const discoveryStep = (identity: string) =>
  ({
    kind: "command",
    command: "x.command-discovery",
    args: [identity],
  }) as const;
const showNext = discoveryStep("x.show");
const pairNext = discoveryStep("x.pair");

type Expected = {
  readonly commandIdentity: string;
  readonly causeCode: string;
  readonly message: string;
  readonly next: unknown;
};

function refusal(
  commandIdentity: string,
  message: string,
  next: unknown = helpStep,
  causeCode = usage,
): Expected {
  return { commandIdentity, causeCode, message, next };
}

function read(value: unknown, key: string): unknown {
  return Reflect.get(Object(value), key);
}

function facts(envelope: unknown) {
  const result = read(envelope, "result");
  return {
    message: read(envelope, "message"),
    commandIdentity: read(result, "commandIdentity"),
    causeCode: read(result, "causeCode"),
    data: read(result, "data"),
    next: read(result, "next"),
  };
}

function usageContract() {
  return contractFor({
    cli: "x",
    commands: [slotShow(), bareList(), pairShow()],
  });
}

function repairOf(envelope: unknown) {
  const result = read(envelope, "result");
  return {
    repairAction: read(result, "repairAction"),
    next: read(result, "next"),
  };
}

async function envelopeOf(
  argv: readonly string[],
  contract: object = usageContract(),
) {
  const result = await runInProcessOn(
    contract,
    {},
    () => recordingHost().host,
  )(argv);
  if (result.kind !== "envelope")
    throw new Error(`Expected an envelope, got ${result.kind}.`);
  return result;
}

async function inProcess(argv: readonly string[], contract?: object) {
  const result = await envelopeOf(argv, contract);
  return {
    exitCode: result.exitCode,
    facts: facts(result.envelope),
    human: renderHuman("x", result.envelope),
  };
}

async function expectInProcess(
  argv: readonly string[],
  expected: Expected,
  contract?: object,
) {
  expect(await inProcess(argv, contract)).toEqual({
    exitCode: 2,
    facts: { ...expected, data: null },
    human: [
      {
        stream: "stderr",
        text: `x: ${expected.message} [${expected.causeCode}]\n`,
      },
    ],
  });
}

async function expectProcess(
  scenario: string,
  argv: readonly string[],
  expected: Expected,
) {
  const run = (tokens: readonly string[]) =>
    spawnBounded([process.execPath, entry, scenario, ...tokens], {
      env: { ...process.env },
    });
  const human = await run(argv);
  expect({
    exit: human.exit,
    stdout: human.stdout,
    stderr: human.stderr,
  }).toEqual({
    exit: 2,
    stdout: "",
    stderr: `x: ${expected.message} [${expected.causeCode}]\n`,
  });
  const machine = await run(["--json", ...argv]);
  expect({ exit: machine.exit, stderr: machine.stderr }).toEqual({
    exit: 2,
    stderr: "",
  });
  expect(facts(JSON.parse(machine.stdout))).toEqual({
    ...expected,
    data: null,
  });
}

describe("a bare invocation gives one line of usage guidance", () => {
  test(
    "the production entry names --help on stderr and in the envelope message, exit 2",
    async () => {
      await expectProcess("usage", [], refusal("x.dispatch", bare));
    },
    processWatchdog(2),
  );

  test("an in-process run refuses the bare invocation with the same words and the help step", async () => {
    await expectInProcess([], refusal("x.dispatch", bare));
    await expectInProcess(["--json"], refusal("x.dispatch", bare));
  });

  test("resolving a bare invocation carries the guidance as its message", async () => {
    expect(await usageContract().resolve([])).toEqual({
      ok: false,
      commandIdentity: "x.dispatch",
      causeCode: usage,
      machine: false,
      message: bare,
    });
  });

  test("an unknown command keeps its own words, so only the bare invocation changed", async () => {
    await expectInProcess(
      ["nosuch"],
      refusal(
        "x.dispatch",
        "No declared command matches this invocation.",
        {
          kind: "instruction",
          text: "Select a command identity from availablePaths, then run that command's route.",
        },
        "USAGE_UNKNOWN_COMMAND",
      ),
    );
  });
});

const rows: readonly (readonly [string, readonly string[], Expected])[] = [
  [
    "two navigation switches",
    ["--help", "--discover"],
    refusal(
      "x.dispatch",
      "Use only one of --help, --discover, --discover-all and --discover-command.",
    ),
  ],
  [
    "a navigation switch after a command",
    ["show", "--discover"],
    refusal(
      "x.dispatch",
      "Give --help, --discover or --discover-all alone, or --discover-command with one command identity.",
    ),
  ],
  [
    "a deadline that is not a positive whole number",
    ["show", "--deadline-ms", "0"],
    refusal(
      "x.dispatch",
      "The option --deadline-ms needs one positive whole number of milliseconds.",
    ),
  ],
  [
    "a deadline on help",
    ["--help", "--deadline-ms", "5"],
    refusal("x.dispatch", "This command does not accept --deadline-ms."),
  ],
  [
    "a deadline on a command that does not support one",
    ["show", "--title", "a", "--deadline-ms", "5"],
    refusal("x.show", "This command does not accept --deadline-ms.", showNext),
  ],
  [
    "an option the command does not declare",
    ["show", "--title", "a", "--nope"],
    refusal(
      "x.show",
      "The invocation uses an option this command does not declare.",
      showNext,
    ),
  ],
  [
    "one argument too many",
    ["show", "--title", "a", "abc", "def"],
    refusal(
      "x.show",
      "The invocation has more arguments than this command accepts.",
      showNext,
    ),
  ],
  [
    "a missing required option",
    ["show"],
    refusal("x.show", "The required option --title is missing.", showNext),
  ],
  [
    "a missing required argument",
    ["pair"],
    refusal("x.pair", "The required argument name is missing.", pairNext),
  ],
  [
    "an option given by its alias with no value",
    ["show", "-t"],
    refusal("x.show", "The option --title needs a value.", showNext),
  ],
  [
    "an option given twice, once by its alias",
    ["show", "--title", "a", "-t", "b"],
    refusal("x.show", "The option --title can be given only once.", showNext),
  ],
  [
    "an integer that is not a whole number",
    ["show", "--title", "a", "--count", "x"],
    refusal("x.show", "The option --count must be a whole number.", showNext),
  ],
  [
    "an integer out of its bounds",
    ["show", "--title", "a", "--count", "10"],
    refusal(
      "x.show",
      "The option --count must be a whole number from 1 to 9.",
      showNext,
    ),
  ],
  [
    "a string longer than its bound",
    ["show", "--title", "a".repeat(21)],
    refusal(
      "x.show",
      "The option --title must be 1 to 20 characters long.",
      showNext,
    ),
  ],
  [
    "a value outside its choices",
    ["show", "--title", "a", "--mode", "c"],
    refusal("x.show", "The option --mode must be one of: a, b.", showNext),
  ],
  [
    "a value that breaks its pattern",
    ["show", "--title", "a", "ABC"],
    refusal(
      "x.show",
      "The argument item must match the pattern [a-z]+.",
      showNext,
    ),
  ],
  [
    "an option without the option it requires",
    ["pair", "a", "--both"],
    refusal(
      "x.pair",
      "The option --both needs the option --left as well.",
      pairNext,
    ),
  ],
  [
    "two exclusive options, named in member order",
    ["pair", "a", "--up", "--right"],
    refusal(
      "x.pair",
      "The option --right and the option --up cannot be used together.",
      pairNext,
    ),
  ],
  [
    "a missing required slot and a broken constraint",
    ["pair", "--both"],
    refusal("x.pair", "The required argument name is missing.", pairNext),
  ],
];

describe("a usage refusal says what was wrong", () => {
  for (const [name, argv, expected] of rows)
    test(`${name}: ${expected.message}`, async () => {
      await expectInProcess(argv, expected);
    });

  test("resolving an invocation carries the same words as the envelope", async () => {
    expect(await usageContract().resolve(["show", "--json"])).toEqual({
      ok: false,
      commandIdentity: "x.show",
      causeCode: usage,
      machine: true,
      message: "The required option --title is missing.",
    });
    expect(await usageContract().resolve(["show", 5])).toEqual({
      ok: false,
      commandIdentity: "x.dispatch",
      causeCode: usage,
      machine: false,
      message: "The invocation is not valid for the selected command.",
    });
  });

  test(
    "the production entry prints the same words on stderr and in the JSON envelope",
    async () => {
      for (const [, argv, expected] of rows.filter(([name]) =>
        [
          "a missing required option",
          "an option the command does not declare",
          "a value that breaks its pattern",
          "an integer out of its bounds",
          "an option without the option it requires",
          "two exclusive options, named in member order",
        ].includes(name),
      ))
        await expectProcess("usage", argv, expected);
    },
    processWatchdog(12),
  );

  test("a value the pattern cannot check in time names its slot", async () => {
    const hostile = command({
      capabilities: {},
      identity: "x.hostile",
      route: ["hostile"],
      summary: "Pattern budget.",
      input: {
        ...emptyInput,
        arguments: [
          {
            name: "item",
            summary: "Item.",
            required: true,
            value: {
              kind: "string",
              minLength: 1,
              maxLength: 4096,
              choices: null,
              pattern: "(a+)+",
            },
          },
        ],
      },
      run: readsUnchanged("x.hostile"),
    });
    await expectInProcess(
      ["hostile", `${"a".repeat(100)}!`],
      refusal(
        "x.hostile",
        "The argument item could not be checked against its declared pattern in time.",
        discoveryStep("x.hostile"),
      ),
      contractFor({ cli: "x", commands: [hostile] }),
    );
  });

  test("a root command given no input asks for an option or argument", async () => {
    const root = command({
      capabilities: {},
      identity: "x.root",
      route: [],
      summary: "Root.",
      input: {
        ...emptyInput,
        options: [
          {
            name: "--all",
            aliases: [],
            summary: "All.",
            required: false,
            repeatable: false,
            value: null,
          },
        ],
      },
      run: readsUnchanged("x.root"),
    });
    await expectInProcess(
      ["--"],
      refusal(
        "x.root",
        "This command needs at least one option or argument.",
        discoveryStep("x.root"),
      ),
      contractFor({ cli: "x", commands: [root] }),
    );
  });

  test("a value that its next step's target would refuse names the later step", async () => {
    const item = (choices: readonly string[] | null) =>
      ({
        ...emptyInput,
        arguments: [
          {
            name: "item",
            summary: "Item.",
            required: true,
            value: {
              kind: "string",
              minLength: 1,
              maxLength: 12,
              choices,
              pattern: null,
            },
          },
        ],
      }) as const satisfies InputSchema;
    const selected = station(commonCauses, {
      commandIdentity: "x.source",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Read.",
      guidance: {
        next: {
          kind: "command",
          command: "x.target",
          args: ["{binding.item}"],
        },
      },
      repairAction: null,
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "usage-later-step",
    });
    const source = command({
      identity: "x.source",
      route: ["source"],
      summary: "Read a source.",
      input: item(null),
      capabilities: {},
      futureBindings: { item: "item" },
      stations: [selected],
      run: (input, context) =>
        context.result(selected, {
          message: "Read.",
          data: null,
          bindings: { item: input.item },
          effects: unchanged,
        }),
    });
    const target = command({
      identity: "x.target",
      route: ["target"],
      summary: "Read a target.",
      input: item(["alpha"]),
      capabilities: {},
      run: readsUnchanged("x.target"),
    });
    await expectInProcess(
      ["source", "beta"],
      refusal(
        "x.source",
        "A value in this invocation cannot be passed on to this command's next step.",
        discoveryStep("x.source"),
      ),
      contractFor({ cli: "x", commands: [source, target] }),
    );
  });

  test("contract.parse keeps its path and reason for each new fault", async () => {
    const contract = usageContract();
    const required = {
      ok: false,
      path: "input",
      reason: "required slot or constraint",
    } as const;
    expect(await contract.parse("x.pair", [])).toEqual(required);
    expect(await contract.parse("x.pair", ["a", "--both"])).toEqual(required);
    expect(await contract.parse("x.pair", ["a", "--left", "--up"])).toEqual(
      required,
    );
    expect(await contract.parse("x.show", ["-t"])).toEqual({
      ok: false,
      path: "--title",
      reason: "missing value",
    });
    expect(await contract.parse("x.show", ["--title", "a", "ABC"])).toEqual({
      ok: false,
      path: "input",
      reason: "pattern mismatch",
    });
  });
});

const suggestions: readonly (readonly [string, readonly string[], Expected])[] =
  [
    [
      "--titel suggests --title",
      ["show", "--title", "a", "--titel"],
      refusal(
        "x.show",
        "The invocation uses an option this command does not declare. Did you mean --title?",
        showNext,
      ),
    ],
    [
      "a swap of two adjacent letters is one edit, so --lfet suggests --left",
      ["pair", "a", "--lfet"],
      refusal(
        "x.pair",
        "The invocation uses an option this command does not declare. Did you mean --left?",
        pairNext,
      ),
    ],
    [
      "a one-letter typo of a longer name, --cont, suggests --count",
      ["show", "--title", "a", "--cont"],
      refusal(
        "x.show",
        "The invocation uses an option this command does not declare. Did you mean --count?",
        showNext,
      ),
    ],
    [
      "a typo of the alias --reviewer suggests the canonical --reviewer-name",
      ["pair", "a", "--reviewr"],
      refusal(
        "x.pair",
        "The invocation uses an option this command does not declare. Did you mean --reviewer-name?",
        pairNext,
      ),
    ],
    [
      "the absolute limit admits distance 2 from --reviewer-name",
      ["pair", "a", "--reviewer-nazz"],
      refusal(
        "x.pair",
        "The invocation uses an option this command does not declare. Did you mean --reviewer-name?",
        pairNext,
      ),
    ],
    [
      "the absolute limit refuses distance 3 from --reviewer-name",
      ["pair", "a", "--reviewer-nzzz"],
      refusal(
        "x.pair",
        "The invocation uses an option this command does not declare.",
        pairNext,
      ),
    ],
    [
      "the half-length limit admits distance 1 from --left",
      ["pair", "a", "--lefx"],
      refusal(
        "x.pair",
        "The invocation uses an option this command does not declare. Did you mean --left?",
        pairNext,
      ),
    ],
    [
      "the half-length limit refuses distance 2 from --left",
      ["pair", "a", "--lexx"],
      refusal(
        "x.pair",
        "The invocation uses an option this command does not declare.",
        pairNext,
      ),
    ],
    [
      "a tie between --tag and --flag suggests --tag, the first declared",
      ["show", "--title", "a", "--tlag"],
      refusal(
        "x.show",
        "The invocation uses an option this command does not declare. Did you mean --tag?",
        showNext,
      ),
    ],
    [
      "a 5,000-character option suggests nothing, since a declared name whose length differs from it by more than 2 is skipped unmeasured",
      ["show", "--title", "a", `--${"a".repeat(4998)}`],
      refusal(
        "x.show",
        "The invocation uses an option this command does not declare.",
        showNext,
      ),
    ],
  ];

describe("an undeclared option suggests the closest declared option", () => {
  for (const [name, argv, expected] of suggestions)
    test(name, async () => {
      await expectInProcess(argv, expected);
    });

  test(
    "the production entry prints each suggestion on stderr and in the JSON envelope",
    async () => {
      for (const [, argv, expected] of suggestions)
        await expectProcess("usage", argv, expected);
    },
    processWatchdog(2 * suggestions.length),
  );
});

const stepRoutes: Readonly<Record<string, readonly string[]>> = {
  "x.command-discovery": ["--discover-command"],
};

function discoveredWords(
  contract: { readonly discoverCommand: (identity: string) => unknown },
  identity: string,
  causeCode: string,
) {
  const stations = read(contract.discoverCommand(identity), "stations");
  const found: unknown = Array.isArray(stations)
    ? stations.find((entry) => read(entry, "causeCode") === causeCode)
    : undefined;
  return {
    repairAction: read(found, "repairAction"),
    next: read(read(found, "guidance"), "next"),
  };
}

const hostWords = {
  repairAction: repairWords.discovery,
  next: discoveryStep("x.show"),
};
const helpWords = { repairAction: repairWords.inspect, next: helpStep };

const itemInput = {
  ...emptyInput,
  arguments: [
    {
      name: "item",
      summary: "Item.",
      required: true,
      value: {
        kind: "string",
        minLength: 1,
        maxLength: 8,
        choices: null,
        pattern: null,
      },
    },
  ],
} as const satisfies InputSchema;

function ownUsage(identity: string, route: string) {
  return command({
    identity,
    route: [route],
    summary: "Read one item.",
    input: itemInput,
    capabilities: {},
    run: readsUnchanged(identity),
  });
}

describe("a host command's usage refusal points at its own discovery", () => {
  test(
    "running the refusal's next step prints that command's discovery and exits 0",
    async () => {
      const refused = await spawnBounded(
        [process.execPath, entry, "usage", "show", "--json"],
        { env: { ...process.env } },
      );
      const next = facts(JSON.parse(refused.stdout)).next;
      expect(next).toEqual(discoveryStep("x.show"));
      const route = stepRoutes[String(read(next, "command"))] ?? [];
      const args = read(next, "args");
      const vector = [
        ...route,
        ...(Array.isArray(args) ? args.map(String) : []),
      ];
      expect(vector).toEqual(["--discover-command", "x.show"]);
      const shown = await spawnBounded(
        [process.execPath, entry, "usage", ...vector],
        { env: { ...process.env } },
      );
      expect({ exit: shown.exit, stderr: shown.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(
        shown.stdout.startsWith(
          "x.show (inspect)\nShow a title.\nRoute: show\n",
        ),
      ).toBe(true);
    },
    processWatchdog(2),
  );

  test(
    "the production entry pairs the discovery repair words with the discovery step, and a bare invocation keeps the inspect words with help",
    async () => {
      const run = (tokens: readonly string[]) =>
        spawnBounded([process.execPath, entry, "usage", ...tokens], {
          env: { ...process.env },
        });
      const host = await run(["show", "--json"]);
      const bareRun = await run(["--json"]);
      expect([
        repairOf(JSON.parse(host.stdout)),
        repairOf(JSON.parse(bareRun.stdout)),
      ]).toEqual([hostWords, helpWords]);
    },
    processWatchdog(2),
  );

  test("an in-process usage refusal pairs the discovery repair words with the discovery step, and a bare invocation keeps the inspect words with help", async () => {
    expect([
      repairOf((await envelopeOf(["show"])).envelope),
      repairOf((await envelopeOf([])).envelope),
    ]).toEqual([hostWords, helpWords]);
  });

  test("discovery shows the discovery words for usage and keeps the inspect words with help for a schema refusal and for dispatch", () => {
    const contract = usageContract();
    expect([
      discoveredWords(contract, "x.show", usage),
      discoveredWords(contract, "x.show", "SCHEMA_INVALID_INPUT"),
      discoveredWords(contract, "x.dispatch", usage),
    ]).toEqual([hostWords, helpWords, helpWords]);
  });

  test("a command that declares its own usage station keeps its words", async () => {
    const own = station(commonCauses, {
      commandIdentity: "x.own",
      causeCode: "USAGE_INVALID_INVOCATION",
      trigger: "Own usage refusal.",
      guidance: {
        next: { kind: "instruction", text: "Name one item for x.own." },
      },
      repairAction: "Name one item.",
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "usage-own-station",
    });
    const served = station(commonCauses, {
      commandIdentity: "x.own",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Read.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "usage-own-read",
    });
    const declared = command({
      identity: "x.own",
      route: ["own"],
      summary: "Read one item.",
      input: itemInput,
      capabilities: {},
      stations: [own, served],
      run: (_input, context) =>
        context.result(served, {
          message: "Read.",
          data: null,
          effects: unchanged,
        }),
    });
    const contract = contractFor({ cli: "x", commands: [declared] });
    const ownNext = {
      kind: "instruction",
      text: "Name one item for x.own.",
    } as const;
    await expectInProcess(
      ["own"],
      refusal("x.own", "The required argument item is missing.", ownNext),
      contract,
    );
    expect(repairOf((await envelopeOf(["own"], contract)).envelope)).toEqual({
      repairAction: "Name one item.",
      next: ownNext,
    });
  });

  test("an identity a discovery step cannot carry falls back to help with the inspect repair words and still validates", async () => {
    for (const [identity, route] of [
      ["x.{odd}", "odd"],
      ["-odd", "dash"],
    ] as const) {
      const contract = contractFor({
        cli: "x",
        commands: [ownUsage(identity, route)],
      });
      const result = await envelopeOf([route], contract);
      expect({
        exitCode: result.exitCode,
        facts: facts(result.envelope),
        words: repairOf(result.envelope),
      }).toEqual({
        exitCode: 2,
        facts: {
          ...refusal(identity, "The required argument item is missing."),
          data: null,
        },
        words: helpWords,
      });
      expect((await contract.validate(result.envelope)).ok).toBe(true);
    }
  });
});

const shape =
  "Give --help, --discover or --discover-all alone, or --discover-command with one command identity.";
const kept: readonly (readonly [string, readonly string[], Expected])[] = [
  [
    "--help with another navigation switch is a conflict",
    ["show", "--help", "--discover"],
    refusal(
      "x.dispatch",
      "Use only one of --help, --discover, --discover-all and --discover-command.",
    ),
  ],
  [
    "--help with a deadline refuses the deadline",
    ["show", "--help", "--deadline-ms", "5"],
    refusal("x.dispatch", "This command does not accept --deadline-ms."),
  ],
  [
    "--help after -- is an operand of the command",
    ["show", "--", "--help"],
    refusal(
      "x.show",
      "The argument item must match the pattern [a-z]+.",
      showNext,
    ),
  ],
  [
    "--help before a route keeps the shape refusal",
    ["--help", "show"],
    refusal("x.dispatch", shape),
  ],
  [
    "--discover after a route keeps the shape refusal",
    ["show", "--discover"],
    refusal("x.dispatch", shape),
  ],
  [
    "--discover-command after a route keeps the shape refusal",
    ["show", "--discover-command", "x.show"],
    refusal("x.dispatch", shape),
  ],
];

const asHelp: readonly (readonly [readonly string[], readonly string[]])[] = [
  [
    ["show", "--help"],
    ["--discover-command", "x.show"],
  ],
  [
    ["show", "--title", "a", "--help"],
    ["--discover-command", "x.show"],
  ],
  [
    ["show", "--nope", "--help"],
    ["--discover-command", "x.show"],
  ],
  [["nope", "--help"], ["--help"]],
];

function asked(argv: readonly string[]) {
  return spawnBounded([process.execPath, entry, "usage", ...argv], {
    env: { ...process.env },
  });
}

function discovered(data: unknown): unknown {
  return read(read(data, "command"), "commandIdentity");
}

function sharedPrefix() {
  const all = command({
    identity: "x.all",
    route: ["show", "all"],
    summary: "Show every title.",
    input: emptyInput,
    capabilities: {},
    run: readsUnchanged("x.all"),
  });
  return contractFor({ cli: "x", commands: [slotShow(), all] });
}

describe("a command followed by --help answers with that command's discovery", () => {
  test(
    "the production entry prints what --discover-command prints for the command, or plain help for no command, and exits 0",
    async () => {
      const shown = await asked(["--discover-command", "x.show"]);
      expect(
        shown.stdout.startsWith(
          "x.show (inspect)\nShow a title.\nRoute: show\n",
        ),
      ).toBe(true);
      const help = await asked(["--help"]);
      expect(help.stdout.startsWith("Usage: x <command> [options]\n")).toBe(
        true,
      );
      for (const [argv, same] of asHelp) {
        const expected = same[0] === "--help" ? help : shown;
        const run = await asked(argv);
        expect({
          exit: run.exit,
          stdout: run.stdout,
          stderr: run.stderr,
        }).toEqual({ exit: 0, stdout: expected.stdout, stderr: "" });
      }
    },
    processWatchdog(2 + asHelp.length),
  );

  test(
    "the production entry's JSON envelope names command discovery and carries the data --discover-command carries",
    async () => {
      const shown = await asked(["--json", "--discover-command", "x.show"]);
      const help = await asked(["--json", "--help"]);
      const run = await asked(["show", "--help", "--json"]);
      const none = await asked(["nope", "--help", "--json"]);
      expect([run.exit, run.stderr, none.exit, none.stderr]).toEqual([
        0,
        "",
        0,
        "",
      ]);
      const ran = facts(JSON.parse(run.stdout));
      expect(ran.commandIdentity).toBe("x.command-discovery");
      expect(discovered(ran.data)).toBe("x.show");
      expect(ran).toEqual(facts(JSON.parse(shown.stdout)));
      const unmatched = facts(JSON.parse(none.stdout));
      expect(unmatched.commandIdentity).toBe("x.help");
      expect(unmatched).toEqual(facts(JSON.parse(help.stdout)));
    },
    processWatchdog(4),
  );

  test("an in-process run answers each form as its discovery or help twin", async () => {
    for (const [argv, same] of asHelp) {
      const run = await inProcess(argv);
      expect(run.exitCode).toBe(0);
      expect(run).toEqual(await inProcess(same));
    }
  });

  test("resolving a command followed by --help resolves to its command discovery", async () => {
    const contract = usageContract();
    const resolved = await contract.resolve(["show", "--help"]);
    expect(resolved).toEqual({
      ok: true,
      value: {
        commandIdentity: "x.command-discovery",
        machine: false,
        input: { commandIdentity: "x.show" },
      },
    });
    expect(resolved).toEqual(
      await contract.resolve(["--discover-command", "x.show"]),
    );
  });

  test("the longest declared route before --help wins", async () => {
    const contract = sharedPrefix();
    for (const [argv, identity] of [
      [["show", "all", "--help"], "x.all"],
      [["show", "all", "extra", "--help"], "x.all"],
      [["show", "--help"], "x.show"],
    ] as const) {
      const run = await inProcess(argv, contract);
      expect(discovered(run.facts.data)).toBe(identity);
      expect(run).toEqual(
        await inProcess(["--discover-command", identity], contract),
      );
    }
  });

  test("an identity a discovery step cannot carry answers with plain help and still validates", async () => {
    for (const [identity, route] of [
      ["x.{odd}", "odd"],
      ["-odd", "dash"],
    ] as const) {
      const contract = contractFor({
        cli: "x",
        commands: [ownUsage(identity, route)],
      });
      const result = await envelopeOf([route, "--help"], contract);
      expect({
        exitCode: result.exitCode,
        facts: facts(result.envelope),
      }).toEqual({
        exitCode: 0,
        facts: facts((await envelopeOf(["--help"], contract)).envelope),
      });
      expect(read(read(result.envelope, "result"), "commandIdentity")).toBe(
        "x.help",
      );
      expect((await contract.validate(result.envelope)).ok).toBe(true);
    }
  });
});

describe("every other navigation form keeps its answer", () => {
  for (const [name, argv, expected] of kept)
    test(`${name}: ${expected.message}`, async () => {
      await expectInProcess(argv, expected);
    });

  test(
    "the production entry keeps each refusal and still answers the bare navigation switches",
    async () => {
      for (const [, argv, expected] of kept)
        await expectProcess("usage", argv, expected);
      for (const [argv, identity] of [
        [["--help"], "x.help"],
        [["--discover"], "x.discovery"],
        [["--discover-command", "x.show"], "x.command-discovery"],
      ] as const) {
        const run = await asked(["--json", ...argv]);
        expect({
          exit: run.exit,
          stderr: run.stderr,
          identity: facts(JSON.parse(run.stdout)).commandIdentity,
        }).toEqual({ exit: 0, stderr: "", identity });
      }
    },
    processWatchdog(2 * kept.length + 3),
  );
});
