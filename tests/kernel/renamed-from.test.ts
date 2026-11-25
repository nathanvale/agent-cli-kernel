import { describe, expect, test } from "bun:test";
import { command, contractFor } from "../../kernel/src/kernel/index.ts";
import type { Envelope, InputSchema } from "../../kernel/src/kernel/index.ts";
import {
  runInProcessOn,
  runProcessOn,
} from "../../kernel/src/kernel/lifecycle.ts";
import { neverRuns, readsUnchanged } from "./kernel-repair/handlers.ts";
import { emptyInput, unchanged } from "./kernel-repair/shapes.ts";
import { recordingHost } from "./lifecycle/recording-host.ts";

const limitInput: InputSchema = {
  ...emptyInput,
  options: [
    {
      name: "--limit",
      aliases: [],
      summary: "Maximum entries.",
      required: false,
      repeatable: false,
      value: { kind: "integer", minimum: 1, maximum: 50 },
    },
  ],
};

function earlierCommand() {
  return command({
    identity: "gates.changelog-earlier",
    route: ["changelog", "earlier"],
    renamedFrom: [["changelog-earlier"], ["old", "changelog", "earlier"]],
    summary: "Show earlier changelog entries.",
    input: limitInput,
    capabilities: {},
    run: (input, context) =>
      context.result(
        {
          commandIdentity: "gates.changelog-earlier",
          causeCode: "SUCCESS_UNCHANGED",
        },
        {
          message: `Limit ${String(input["--limit"] ?? 10)}.`,
          data: { limit: input["--limit"] ?? 10 },
          effects: unchanged,
        },
      ),
  });
}

function plainCommand() {
  return command({
    identity: "gates.status",
    route: ["status"],
    summary: "Show current status.",
    input: emptyInput,
    capabilities: {},
    run: readsUnchanged("gates.status"),
  });
}

function gatesContract() {
  return contractFor({
    cli: "gates",
    commands: [earlierCommand(), plainCommand()],
  });
}

function withoutRunId(envelope: Envelope) {
  const { runId: _runId, ...result } = envelope.result;
  void _runId;
  return { ...envelope, result };
}

async function runEnvelope(
  contract: Parameters<typeof runInProcessOn>[0],
  argv: readonly string[],
) {
  const result = await runInProcessOn(
    contract,
    {},
    () => recordingHost().host,
  )(argv);
  if (result.kind !== "envelope")
    throw new Error(`Expected envelope, got ${result.kind}.`);
  return { exitCode: result.exitCode, envelope: withoutRunId(result.envelope) };
}

async function runHuman(
  contract: ReturnType<typeof gatesContract>,
  argv: readonly string[],
) {
  const recorder = recordingHost();
  const exit = await runProcessOn(contract, {}, () => recorder.host)(argv);
  const stdout = recorder.writes
    .filter((entry) => entry.stream === "stdout")
    .map((entry) => entry.text)
    .join("");
  const stderr = recorder.writes
    .filter((entry) => entry.stream === "stderr")
    .map((entry) => entry.text)
    .join("");
  return { exit, stdout, stderr };
}

function rawDeclaration(
  identity: string,
  route: readonly string[],
  renamedFrom?: readonly (readonly string[])[],
) {
  return {
    commandIdentity: identity,
    route,
    ...(renamedFrom === undefined ? {} : { renamedFrom }),
    summary: "Raw command.",
    input: emptyInput,
    capabilities: {},
    stations: [],
    effectClass: "inspect",
    execute: neverRuns,
  } as const;
}

const currentHelpText = [
  "gates.changelog-earlier (inspect)",
  "Show earlier changelog entries.",
  "Route: changelog earlier",
  "Options:",
  "  --limit <integer, 1 to 50>  optional  Maximum entries.",
  "Possible results:",
  "  success SUCCESS_UNCHANGED  Show earlier changelog entries.",
  "  refused USAGE_INVALID_INVOCATION  Kernel USAGE_INVALID_INVOCATION.",
  "  refused SCHEMA_INVALID_INPUT  Kernel SCHEMA_INVALID_INPUT.",
  "  refused INTERNAL_PREPARATION  Kernel INTERNAL_PREPARATION.",
  "  failed INTERNAL_RESULT_UNCHANGED  Kernel INTERNAL_RESULT_UNCHANGED.",
  "",
].join("\n");

const renamedHelpText = [
  "gates.changelog-earlier (inspect)",
  "Show earlier changelog entries.",
  "Renamed to `changelog earlier`.",
  "Route: changelog earlier",
  "Options:",
  "  --limit <integer, 1 to 50>  optional  Maximum entries.",
  "Possible results:",
  "  success SUCCESS_UNCHANGED  Show earlier changelog entries.",
  "  refused USAGE_INVALID_INVOCATION  Kernel USAGE_INVALID_INVOCATION.",
  "  refused SCHEMA_INVALID_INPUT  Kernel SCHEMA_INVALID_INPUT.",
  "  refused INTERNAL_PREPARATION  Kernel INTERNAL_PREPARATION.",
  "  failed INTERNAL_RESULT_UNCHANGED  Kernel INTERNAL_RESULT_UNCHANGED.",
  "",
].join("\n");

const bareHelpText = [
  "Usage: gates <command> [options]",
  "Commands for gates.",
  "",
  "Commands:",
  "  changelog earlier (gates.changelog-earlier)  Show earlier changelog entries.",
  "  status (gates.status)  Show current status.",
  "",
  "Options:",
  "  --json  Emit one machine-readable result.",
  "  --help  Show help.",
  "  --discover  Discover commands.",
  "  --discover-command <identity>  Discover one command.",
  "",
].join("\n");

describe("renamedFrom route aliases", () => {
  test("an old route runs the command with output identical to the current route", async () => {
    const contract = gatesContract();
    const current = await runEnvelope(contract, [
      "changelog",
      "earlier",
      "--limit",
      "5",
    ]);
    const singleWordAlias = await runEnvelope(contract, [
      "changelog-earlier",
      "--limit",
      "5",
    ]);
    const multiWordAlias = await runEnvelope(contract, [
      "old",
      "changelog",
      "earlier",
      "--limit",
      "5",
    ]);
    expect(current.exitCode).toBe(0);
    expect(singleWordAlias).toEqual(current);
    expect(multiWordAlias).toEqual(current);
  });

  test("--help through an old route shows the Renamed to line and --help through the current route does not", async () => {
    const contract = gatesContract();
    const viaCurrent = await runHuman(contract, [
      "changelog",
      "earlier",
      "--help",
    ]);
    const viaOld = await runHuman(contract, ["changelog-earlier", "--help"]);
    const viaMultiWordOld = await runHuman(contract, [
      "old",
      "changelog",
      "earlier",
      "--help",
    ]);
    const viaDiscoverCommand = await runHuman(contract, [
      "--discover-command",
      "gates.changelog-earlier",
    ]);
    const bareHelp = await runHuman(contract, ["--help"]);
    expect(viaCurrent).toEqual({
      exit: 0,
      stdout: currentHelpText,
      stderr: "",
    });
    expect(viaOld).toEqual({ exit: 0, stdout: renamedHelpText, stderr: "" });
    expect(viaMultiWordOld).toEqual({
      exit: 0,
      stdout: renamedHelpText,
      stderr: "",
    });
    expect(viaDiscoverCommand).toEqual({
      exit: 0,
      stdout: currentHelpText,
      stderr: "",
    });
    expect(bareHelp).toEqual({ exit: 0, stdout: bareHelpText, stderr: "" });
  });

  test("--discover-command shows renamedFrom and --discover lists the command once", async () => {
    const contract = gatesContract();
    const discovered = contract.discoverCommand("gates.changelog-earlier");
    if (!discovered) throw new Error("Expected command discovery.");
    expect(discovered.command).toEqual({
      commandIdentity: "gates.changelog-earlier",
      route: ["changelog", "earlier"],
      renamedFrom: [["changelog-earlier"], ["old", "changelog", "earlier"]],
      summary: "Show earlier changelog entries.",
      effectClass: "inspect",
    });
    const list = contract.discover();
    const matching = list.commands.filter(
      (entry) => entry.commandIdentity === "gates.changelog-earlier",
    );
    expect(matching).toEqual([
      {
        commandIdentity: "gates.changelog-earlier",
        route: ["changelog", "earlier"],
        renamedFrom: [["changelog-earlier"], ["old", "changelog", "earlier"]],
        summary: "Show earlier changelog entries.",
        effectClass: "inspect",
      },
    ]);
    const viaCli = await runEnvelope(contract, [
      "--discover-command",
      "gates.changelog-earlier",
    ]);
    expect(viaCli.exitCode).toBe(0);
    expect(viaCli.envelope.result.data).toEqual(discovered);
  });

  test("a command without renamedFrom keeps discovery output unchanged", async () => {
    const contract = gatesContract();
    const plain = contract.discoverCommand("gates.status");
    expect(plain?.command).toEqual({
      commandIdentity: "gates.status",
      route: ["status"],
      summary: "Show current status.",
      effectClass: "inspect",
    });
    expect(Object.keys(plain?.command ?? {})).toEqual([
      "commandIdentity",
      "route",
      "summary",
      "effectClass",
    ]);
    const tampered = {
      ...plain,
      command: { ...plain?.command, renamedFrom: [["old-status"]] },
    };
    const envelope = {
      contractVersion: "3.0.0",
      message: "Discovery data for one command.",
      availablePaths: ["gates.status"],
      result: {
        runId: "check-run",
        commandIdentity: "gates.command-discovery",
        outcome: "success",
        effectClass: "inspect",
        transactionState: "unchanged",
        causeCode: "SUCCESS_UNCHANGED",
        failureClass: null,
        exitCode: 0,
        data: tampered,
        retryable: false,
        repairAction: null,
        effects: unchanged,
        next: { kind: "done" },
      },
    };
    expect((await contract.validate(envelope)).ok).toBe(false);
  });

  test("refuses an empty old route in renamedFrom", () => {
    const expected =
      "Renamed route cannot be empty. Repair: list a non-empty old route in renamedFrom, or omit renamedFrom.";
    expect(() =>
      command({
        identity: "gates.empty",
        route: ["empty"],
        renamedFrom: [[]],
        summary: "Empty alias.",
        input: emptyInput,
        capabilities: {},
        run: readsUnchanged("gates.empty"),
      }),
    ).toThrow(expected);
    expect(() =>
      contractFor({
        cli: "gates",
        commands: [rawDeclaration("gates.empty", ["empty"], [[]])],
      }),
    ).toThrow(expected);
  });

  test("refuses an old route with an invalid route token", () => {
    const emptyToken =
      'Route token "" is empty or option-like and can never be matched. Repair: use non-empty words that do not start with "-" in renamedFrom.';
    const optionToken =
      'Route token "--old" is empty or option-like and can never be matched. Repair: use non-empty words that do not start with "-" in renamedFrom.';
    expect(() =>
      command({
        identity: "gates.bad-empty",
        route: ["good"],
        renamedFrom: [[""]],
        summary: "Bad empty token.",
        input: emptyInput,
        capabilities: {},
        run: readsUnchanged("gates.bad-empty"),
      }),
    ).toThrow(emptyToken);
    expect(() =>
      command({
        identity: "gates.bad-option",
        route: ["good"],
        renamedFrom: [["--old"]],
        summary: "Bad option token.",
        input: emptyInput,
        capabilities: {},
        run: readsUnchanged("gates.bad-option"),
      }),
    ).toThrow(optionToken);
    expect(() =>
      contractFor({
        cli: "gates",
        commands: [rawDeclaration("gates.bad-option", ["good"], [["--old"]])],
      }),
    ).toThrow(optionToken);
  });

  test("refuses an old route equal to its own command route", () => {
    const expected =
      "Renamed route duplicates its own command route. Repair: remove the current route from renamedFrom.";
    expect(() =>
      command({
        identity: "gates.self",
        route: ["changelog", "earlier"],
        renamedFrom: [["changelog", "earlier"]],
        summary: "Self alias.",
        input: emptyInput,
        capabilities: {},
        run: readsUnchanged("gates.self"),
      }),
    ).toThrow(expected);
    expect(() =>
      contractFor({
        cli: "gates",
        commands: [
          rawDeclaration(
            "gates.self",
            ["changelog", "earlier"],
            [["changelog", "earlier"]],
          ),
        ],
      }),
    ).toThrow(expected);
  });

  test("refuses duplicate old routes on the same command", () => {
    const expected =
      "Duplicate renamedFrom route. Repair: list each old route at most once in renamedFrom.";
    expect(() =>
      command({
        identity: "gates.dup",
        route: ["current"],
        renamedFrom: [["old"], ["old"]],
        summary: "Duplicate alias.",
        input: emptyInput,
        capabilities: {},
        run: readsUnchanged("gates.dup"),
      }),
    ).toThrow(expected);
    expect(() =>
      contractFor({
        cli: "gates",
        commands: [
          rawDeclaration("gates.dup", ["current"], [["old"], ["old"]]),
        ],
      }),
    ).toThrow(expected);
  });

  test("refuses an old route equal to another command route or old route", () => {
    const expected =
      "Renamed route conflicts with another command route. Repair: remove the conflicting route from renamedFrom.";
    const first = command({
      identity: "gates.first",
      route: ["first"],
      renamedFrom: [["shared-old"]],
      summary: "First.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.first"),
    });
    const collidesCurrent = command({
      identity: "gates.second",
      route: ["second"],
      renamedFrom: [["first"]],
      summary: "Second.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.second"),
    });
    const collidesOld = command({
      identity: "gates.third",
      route: ["third"],
      renamedFrom: [["shared-old"]],
      summary: "Third.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.third"),
    });
    expect(() =>
      contractFor({ cli: "gates", commands: [first, collidesCurrent] }),
    ).toThrow(expected);
    expect(() =>
      contractFor({ cli: "gates", commands: [first, collidesOld] }),
    ).toThrow(expected);
  });

  test("refuses an old route that is a prefix shadowing another command route or old route", () => {
    const expected =
      "Renamed route shadows another command route. Repair: remove the shadowing prefix from renamedFrom.";
    const nested = command({
      identity: "gates.nested",
      route: ["show", "all"],
      summary: "Show all.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.nested"),
    });
    const aliasPrefixOfOther = command({
      identity: "gates.view",
      route: ["view"],
      renamedFrom: [["show"]],
      summary: "View.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.view"),
    });
    const shortRoute = command({
      identity: "gates.short",
      route: ["show"],
      summary: "Show.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.short"),
    });
    const otherPrefixOfAlias = command({
      identity: "gates.view-all",
      route: ["view", "all"],
      renamedFrom: [["show", "all"]],
      summary: "View all.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.view-all"),
    });
    const aliasOne = command({
      identity: "gates.one",
      route: ["one"],
      renamedFrom: [["legacy"]],
      summary: "One.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.one"),
    });
    const aliasTwo = command({
      identity: "gates.two",
      route: ["two"],
      renamedFrom: [["legacy", "sub"]],
      summary: "Two.",
      input: emptyInput,
      capabilities: {},
      run: readsUnchanged("gates.two"),
    });
    expect(() =>
      contractFor({ cli: "gates", commands: [nested, aliasPrefixOfOther] }),
    ).toThrow(expected);
    expect(() =>
      contractFor({ cli: "gates", commands: [shortRoute, otherPrefixOfAlias] }),
    ).toThrow(expected);
    expect(() =>
      contractFor({ cli: "gates", commands: [aliasOne, aliasTwo] }),
    ).toThrow(expected);
  });

  test("allows renamedFrom alongside a root command without false prefix shadowing", async () => {
    const root = command({
      identity: "gates.root",
      route: [],
      summary: "Root command.",
      input: limitInput,
      capabilities: {},
      run: readsUnchanged("gates.root"),
    });
    const contract = contractFor({
      cli: "gates",
      commands: [root, earlierCommand()],
    });
    const ran = await runEnvelope(contract, ["changelog-earlier"]);
    expect(ran.exitCode).toBe(0);
    expect(ran.envelope.result.commandIdentity).toBe("gates.changelog-earlier");
  });
});
