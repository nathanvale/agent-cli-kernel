import { describe, expect, test } from "bun:test";
import { contractFor } from "../../../kernel/src/kernel/index.ts";
import { renderHuman } from "../../../kernel/src/kernel/human.ts";
import { runInProcessOn } from "../../../kernel/src/kernel/lifecycle.ts";
import { bareList, slotShow } from "../kernel-repair/swarm-commands.ts";
import {
  entry,
  processWatchdog,
  spawnBounded,
} from "../kernel-repair/swarm-process.ts";
import { recordingHost } from "../lifecycle/recording-host.ts";

const stations = [
  "Possible results:",
  "  success SUCCESS_UNCHANGED  Show a title.",
  "  refused USAGE_INVALID_INVOCATION  Kernel USAGE_INVALID_INVOCATION.",
  "  refused SCHEMA_INVALID_INPUT  Kernel SCHEMA_INVALID_INPUT.",
  "  refused INTERNAL_PREPARATION  Kernel INTERNAL_PREPARATION.",
  "  failed INTERNAL_RESULT_UNCHANGED  Kernel INTERNAL_RESULT_UNCHANGED.",
];

const showText = [
  "x.show (inspect)",
  "Show a title.",
  "Route: show",
  "Arguments:",
  "  item <string, length 1 to 12, pattern [a-z]+>  optional  Probe item.",
  "Options:",
  "  --title, -t <string, length 1 to 20>  required  Title.",
  "  --tag <string, length 1 to 20>  optional, repeatable  Tag.",
  "  --mode <a|b>  optional  Probe mode.",
  "  --count <integer, 1 to 9>  optional  Probe count.",
  "  --flag  optional  Probe flag.",
  ...stations,
  "",
].join("\n");

const listText = [
  "x.list (inspect)",
  "List titles.",
  "Route: list",
  "Options:",
  "  (none)",
  "Possible results:",
  "  success SUCCESS_UNCHANGED  List titles.",
  "  refused USAGE_INVALID_INVOCATION  Kernel USAGE_INVALID_INVOCATION.",
  "  refused INTERNAL_PREPARATION  Kernel INTERNAL_PREPARATION.",
  "  failed INTERNAL_RESULT_UNCHANGED  Kernel INTERNAL_RESULT_UNCHANGED.",
  "",
].join("\n");

async function rendered(argv: readonly string[]) {
  const contract = contractFor({
    cli: "x",
    commands: [slotShow(), bareList()],
  });
  const result = await runInProcessOn(
    contract,
    {},
    () => recordingHost().host,
  )(argv);
  if (result.kind !== "envelope")
    throw new Error(`Expected an envelope, got ${result.kind}.`);
  expect(result.exitCode).toBe(0);
  return renderHuman("x", result.envelope);
}

async function printed(argv: readonly string[]) {
  return spawnBounded([process.execPath, entry, "slots", ...argv], {
    env: { ...process.env },
  });
}

describe("plain discovery of one command lists its input", () => {
  test("arguments and options print in declared order with their value words", async () => {
    expect(await rendered(["--discover-command", "x.show"])).toEqual([
      { stream: "stdout", text: showText },
    ]);
  });

  test("a command with no arguments or options prints no Arguments heading and Options (none)", async () => {
    expect(await rendered(["--discover-command", "x.list"])).toEqual([
      { stream: "stdout", text: listText },
    ]);
  });

  test(
    "the production entry prints the same text on stdout and exits 0",
    async () => {
      for (const [identity, expected] of [
        ["x.show", showText],
        ["x.list", listText],
      ] as const) {
        const run = await printed(["--discover-command", identity]);
        expect(run.stdout).toBe(expected);
        expect(run.stderr).toBe("");
        expect(run.exit).toBe(0);
      }
    },
    processWatchdog(2),
  );
});

const helpText = [
  "Usage: x <command> [options]",
  "Commands for x.",
  "",
  "Commands:",
  "  list (x.list)  List titles.",
  "  show (x.show)  Show a title.",
  "",
  "Options:",
  "  --json  Emit one machine-readable result.",
  "  --help  Show help.",
  "  --version  Show the version.",
  "  --discover  Discover commands.",
  "  --discover-all  Discover all commands.",
  "  --discover-command <identity>  Discover one command.",
  "",
].join("\n");

describe("plain help names each command's identity beside its route", () => {
  test("each command line shows the identity --discover-command accepts", async () => {
    expect(await rendered(["--help"])).toEqual([
      { stream: "stdout", text: helpText },
    ]);
  });

  test(
    "the production entry prints the same help on stdout and exits 0",
    async () => {
      const run = await printed(["--help"]);
      expect(run.stdout).toBe(helpText);
      expect(run.stderr).toBe("");
      expect(run.exit).toBe(0);
    },
    processWatchdog(1),
  );
});
