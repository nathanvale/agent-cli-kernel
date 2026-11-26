import { describe, expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
} from "../../kernel/src/kernel/index.ts";
import { renderHuman } from "../../kernel/src/kernel/human.ts";
import { runInProcessOn } from "../../kernel/src/kernel/lifecycle.ts";
import { emptyInput, unchanged } from "./kernel-repair/shapes.ts";
import { recordingHost } from "./lifecycle/recording-host.ts";

const unknownCause = "USAGE_UNKNOWN_COMMAND";
const plain = "No declared command matches this invocation.";

function declared(identity: string, route: readonly string[]) {
  return command({
    identity,
    route,
    summary: "Report.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) =>
      context.result(
        {
          commandIdentity: identity,
          causeCode: "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses,
        },
        { message: "Done.", data: null, effects: unchanged },
      ),
  });
}

const contract = contractFor({
  cli: "x",
  commands: [
    declared("x.status", ["status"]),
    declared("x.family-list", ["family", "list"]),
    declared("x.family-check", ["family", "check"]),
  ],
});

async function run(argv: readonly string[]) {
  const result = await runInProcessOn(
    contract,
    {},
    () => recordingHost().host,
  )(argv);
  if (result.kind !== "envelope")
    throw new Error(`Expected an envelope, got ${result.kind}.`);
  const envelope = result.envelope;
  return {
    exitCode: result.exitCode,
    commandIdentity: envelope.result.commandIdentity,
    causeCode: envelope.result.causeCode,
    message: envelope.message,
    human: renderHuman("x", envelope),
  };
}

function refusedWith(message: string) {
  return {
    exitCode: 2,
    commandIdentity: "x.dispatch",
    causeCode: unknownCause,
    message,
    human: [
      { stream: "stderr" as const, text: `x: ${message} [${unknownCause}]\n` },
    ],
  };
}

const familyList = `${plain} Did you mean "family list"?`;

describe("an unknown route is refused with or without --help", () => {
  test("nosuch thing --help is refused as an unknown command", async () => {
    expect(await run(["nosuch", "thing", "--help"])).toEqual(
      refusedWith(plain),
    );
  });

  test("--help nosuch thing is refused like nosuch thing --help", async () => {
    expect(await run(["--help", "nosuch", "thing"])).toEqual(
      refusedWith(plain),
    );
  });

  test("nosuch thing and nosuch -h are refused as an unknown command", async () => {
    expect(await run(["nosuch", "thing"])).toEqual(refusedWith(plain));
    expect(await run(["nosuch", "-h"])).toEqual(refusedWith(plain));
  });

  test("statsu, with or without --help, is refused with the suggestion status", async () => {
    for (const argv of [["statsu"], ["statsu", "--help"]])
      expect(await run(argv)).toEqual(
        refusedWith(`${plain} Did you mean "status"?`),
      );
  });

  test("family lsit is refused with the suggestion family list", async () => {
    expect(await run(["family", "lsit"])).toEqual(refusedWith(familyList));
  });

  test("famly list is refused with the suggestion family list, the route its later words match", async () => {
    expect(await run(["famly", "list"])).toEqual(refusedWith(familyList));
  });

  test("family lsit --help is refused like family lsit", async () => {
    expect(await run(["family", "lsit", "--help"])).toEqual(
      refusedWith(familyList),
    );
  });

  test("root --help and -h still print root help with exit 0", async () => {
    for (const flag of ["--help", "-h"]) {
      const help = await run([flag]);
      expect([help.exitCode, help.commandIdentity, help.causeCode]).toEqual([
        0,
        "x.help",
        "SUCCESS_UNCHANGED",
      ]);
    }
  });

  test("a group prefix with --help or -h, before or after it, prints root help with exit 0", async () => {
    const root = await run(["--help"]);
    for (const argv of [
      ["family", "--help"],
      ["family", "-h"],
      ["--help", "family"],
    ])
      expect(await run(argv)).toEqual(root);
  });

  test("family --help --json is the root help envelope and validates", async () => {
    const result = await runInProcessOn(
      contract,
      {},
      () => recordingHost().host,
    )(["family", "--help", "--json"]);
    if (result.kind !== "envelope")
      throw new Error(`Expected an envelope, got ${result.kind}.`);
    expect([result.exitCode, result.envelope.result.commandIdentity]).toEqual([
      0,
      "x.help",
    ]);
    expect((await contract.validate(result.envelope)).ok).toBe(true);
  });

  test("a group prefix without --help is still refused with the plain sentence", async () => {
    expect(await run(["family"])).toEqual(refusedWith(plain));
  });

  test("status --help still answers with the command's discovery", async () => {
    const help = await run(["status", "--help"]);
    expect([help.exitCode, help.commandIdentity]).toEqual([
      0,
      "x.command-discovery",
    ]);
    expect(help).toEqual(await run(["--discover-command", "x.status"]));
  });

  test("nosuch --json is the same refusal as an envelope that lists every command", async () => {
    const result = await runInProcessOn(
      contract,
      {},
      () => recordingHost().host,
    )(["nosuch", "--json"]);
    if (result.kind !== "envelope")
      throw new Error(`Expected an envelope, got ${result.kind}.`);
    expect({
      exitCode: result.exitCode,
      causeCode: result.envelope.result.causeCode,
      message: result.envelope.message,
      availablePaths: result.envelope.availablePaths,
    }).toEqual({
      exitCode: 2,
      causeCode: unknownCause,
      message: plain,
      availablePaths: [
        "x.command-discovery",
        "x.discovery",
        "x.dispatch",
        "x.family-check",
        "x.family-list",
        "x.full-discovery",
        "x.help",
        "x.status",
        "x.version",
      ],
    });
  });
});
