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
import { emptyInput, unchanged } from "./kernel-repair/shapes.ts";
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

async function inProcess(
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
      "Use only one of --help, --discover and --discover-command.",
    ),
  ],
  [
    "a navigation switch after a command",
    ["show", "--help"],
    refusal(
      "x.dispatch",
      "Give --help or --discover alone, or --discover-command with one command identity.",
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

function guidanceNext(
  contract: { readonly discoverCommand: (identity: string) => unknown },
  identity: string,
  causeCode: string,
) {
  const stations = read(contract.discoverCommand(identity), "stations");
  const found: unknown = Array.isArray(stations)
    ? stations.find((entry) => read(entry, "causeCode") === causeCode)
    : undefined;
  return read(read(found, "guidance"), "next");
}

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

  test("discovery shows the discovery step for usage and keeps help for a schema refusal and for dispatch", () => {
    const contract = usageContract();
    expect([
      guidanceNext(contract, "x.show", usage),
      guidanceNext(contract, "x.show", "SCHEMA_INVALID_INPUT"),
      guidanceNext(contract, "x.dispatch", usage),
    ]).toEqual([discoveryStep("x.show"), helpStep, helpStep]);
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
    await expectInProcess(
      ["own"],
      refusal("x.own", "The required argument item is missing.", {
        kind: "instruction",
        text: "Name one item for x.own.",
      }),
      contractFor({ cli: "x", commands: [declared] }),
    );
  });

  test("an identity a discovery step cannot carry falls back to help and still validates", async () => {
    for (const [identity, route] of [
      ["x.{odd}", "odd"],
      ["-odd", "dash"],
    ] as const) {
      const contract = contractFor({
        cli: "x",
        commands: [ownUsage(identity, route)],
      });
      const result = await runInProcessOn(
        contract,
        {},
        () => recordingHost().host,
      )([route]);
      if (result.kind !== "envelope")
        throw new Error(`Expected an envelope, got ${result.kind}.`);
      expect({
        exitCode: result.exitCode,
        facts: facts(result.envelope),
      }).toEqual({
        exitCode: 2,
        facts: {
          ...refusal(identity, "The required argument item is missing."),
          data: null,
        },
      });
      expect((await contract.validate(result.envelope)).ok).toBe(true);
    }
  });
});
