import { expect, test } from "bun:test";
import { command, contractFor } from "../../kernel/src/kernel/index.ts";
import { readsUnchanged } from "./kernel-repair/handlers.ts";
import { emptyInput } from "./kernel-repair/shapes.ts";

const cli = contractFor({ cli: "specimen", commands: [] });

function envelope(commandIdentity: string, data: unknown) {
  return {
    contractVersion: "3.0.0",
    message: "Navigation.",
    availablePaths: ["specimen.help"],
    result: {
      runId: "navigation-run",
      commandIdentity,
      outcome: "success",
      effectClass: "inspect",
      transactionState: "unchanged",
      causeCode: "SUCCESS_UNCHANGED",
      failureClass: null,
      exitCode: 0,
      data,
      retryable: false,
      repairAction: null,
      effects: {
        completed: [],
        remaining: [],
        uncertain: [],
        inventoryComplete: true,
      },
      next: { kind: "done" },
    },
  };
}

const read = command({
  identity: "specimen.read",
  route: ["read"],
  summary: "Read a note.",
  input: emptyInput,
  capabilities: {},
  run: readsUnchanged("specimen.read"),
});
const helpCli = contractFor({ cli: "specimen", commands: [read] });

test("help data is complete and agrees with executable declarations", async () => {
  const valid = helpCli.help();
  expect(Object.keys(valid).sort()).toEqual([
    "commands",
    "options",
    "summary",
    "usage",
  ]);
  expect(valid.commands).toEqual([
    {
      commandIdentity: "specimen.read",
      route: ["read"],
      summary: "Read a note.",
      effectClass: "inspect",
    },
  ]);
  expect(valid.options.map((option) => option.name).sort()).toEqual([
    "--discover",
    "--discover-all",
    "--discover-command",
    "--help",
    "--json",
    "--version",
  ]);
  expect((await helpCli.validate(envelope("specimen.help", valid))).ok).toBe(
    true,
  );
  const invalid = [
    null,
    { ...valid, commands: [] },
    { ...valid, usage: undefined },
    { ...valid, extra: true },
    { ...valid, options: [] },
    { ...valid, commands: [{ commandIdentity: "invented" }] },
  ];
  expect(invalid).toHaveLength(6);
  for (const data of invalid)
    expect((await helpCli.validate(envelope("specimen.help", data))).ok).toBe(
      false,
    );
});

test("discovery rejects missing built-ins and altered public contract fields", async () => {
  const valid = cli.discover();
  expect(valid.commands.map((entry) => entry.commandIdentity)).toEqual([
    "specimen.command-discovery",
    "specimen.discovery",
    "specimen.dispatch",
    "specimen.full-discovery",
    "specimen.help",
    "specimen.version",
  ]);
  expect(valid.exitMeanings).toEqual({
    "0": "success",
    "1": "internal",
    "2": "usage",
    "3": "domain",
    "4": "schema",
    "75": "transient",
  });
  expect((await cli.validate(envelope("specimen.discovery", valid))).ok).toBe(
    true,
  );
  const invalid = [
    null,
    { ...valid, contractVersion: "3.1.0" },
    { ...valid, commands: valid.commands.slice(1) },
    { ...valid, commands: [...valid.commands, ...valid.commands] },
    { ...valid, exitMeanings: { ...valid.exitMeanings, "75": "success" } },
    { ...valid, signalExits: { "130": "SIGINT" } },
    { ...valid, extra: true },
  ];
  expect(invalid).toHaveLength(7);
  for (const data of invalid)
    expect((await cli.validate(envelope("specimen.discovery", data))).ok).toBe(
      false,
    );
});

test("command discovery rejects invented schemas and station guidance", async () => {
  const valid = cli.discoverCommand("specimen.help");
  expect(valid).toBeDefined();
  if (!valid) throw new Error("Expected declared built-in.");
  expect(valid.command).toEqual({
    commandIdentity: "specimen.help",
    route: ["--help"],
    summary: "Show help.",
    effectClass: "inspect",
  });
  expect(valid.stations.map((entry) => entry.causeCode).sort()).toEqual([
    "INTERNAL_PREPARATION",
    "INTERNAL_RESULT_UNCHANGED",
    "SUCCESS_UNCHANGED",
  ]);
  expect(
    (await cli.validate(envelope("specimen.command-discovery", valid))).ok,
  ).toBe(true);
  const invalid = [
    null,
    { ...valid, semantics: "observed-outcomes" },
    { ...valid, command: { ...valid.command, commandIdentity: "invented" } },
    { ...valid, input: { ...valid.input, additionalOptions: true } },
    { ...valid, stations: [] },
    {
      ...valid,
      stations: valid.stations.map((entry) => ({
        ...entry,
        repairAction: "Invented repair.",
      })),
    },
    { ...valid, extra: true },
  ];
  expect(invalid).toHaveLength(7);
  for (const data of invalid)
    expect(
      (await cli.validate(envelope("specimen.command-discovery", data))).ok,
    ).toBe(false);
});

test("navigation validation does not invent an order for object keys or catalogues", async () => {
  const discovery = cli.discover();
  expect(
    (
      await cli.validate(
        envelope("specimen.discovery", {
          signalExits: discovery.signalExits,
          effectExclusions: [...discovery.effectExclusions].reverse(),
          exitMeanings: discovery.exitMeanings,
          commands: [...discovery.commands].reverse(),
          contractVersion: discovery.contractVersion,
        }),
      )
    ).ok,
  ).toBe(true);
  const command = cli.discoverCommand("specimen.help");
  if (!command) throw new Error("Expected declared built-in.");
  expect(
    (
      await cli.validate(
        envelope("specimen.command-discovery", {
          ...command,
          stations: [...command.stations].reverse(),
        }),
      )
    ).ok,
  ).toBe(true);
});
