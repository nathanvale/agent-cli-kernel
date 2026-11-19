import { describe, expect, test } from "bun:test";
import { contractFor } from "../../kernel/src/kernel/index.ts";
import { renderHuman } from "../../kernel/src/kernel/human.ts";
import { runInProcessOn } from "../../kernel/src/kernel/lifecycle.ts";
import { bareList, slotShow } from "./kernel-repair/swarm-commands.ts";
import {
  entry,
  processWatchdog,
  spawnBounded,
} from "./kernel-repair/swarm-process.ts";
import { recordingHost } from "./lifecycle/recording-host.ts";

const usage = "USAGE_INVALID_INVOCATION";
const helpStep = { kind: "command", command: "x.help", args: [] } as const;
const bare = "No command was given. Run x --help to list the commands.";

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

function slotsContract() {
  return contractFor({ cli: "x", commands: [slotShow(), bareList()] });
}

async function inProcess(argv: readonly string[]) {
  const result = await runInProcessOn(
    slotsContract(),
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

async function expectInProcess(argv: readonly string[], expected: Expected) {
  expect(await inProcess(argv)).toEqual({
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
      await expectProcess("slots", [], refusal("x.dispatch", bare));
    },
    processWatchdog(2),
  );

  test("an in-process run refuses the bare invocation with the same words and the help step", async () => {
    await expectInProcess([], refusal("x.dispatch", bare));
    await expectInProcess(["--json"], refusal("x.dispatch", bare));
  });

  test("resolving a bare invocation carries the guidance as its message", async () => {
    expect(await slotsContract().resolve([])).toEqual({
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
