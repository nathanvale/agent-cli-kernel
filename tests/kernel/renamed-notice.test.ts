import { describe, expect, test } from "bun:test";
import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../kernel/src/kernel/index.ts";
import type { Envelope, InputSchema } from "../../kernel/src/kernel/index.ts";
import { runProcessOn } from "../../kernel/src/kernel/lifecycle.ts";
import {
  emptyInput,
  repairWords,
  stationWords,
  unchanged,
} from "./kernel-repair/shapes.ts";
import { recordingHost } from "./lifecycle/recording-host.ts";

const listInput: InputSchema = {
  ...emptyInput,
  options: [
    {
      name: "--refuse",
      aliases: [],
      summary: "Refuse the list request.",
      required: false,
      repeatable: false,
      value: null,
    },
  ],
};

function listCommand() {
  return command({
    identity: "x.list",
    route: ["list"],
    renamedFrom: [["show", "all"]],
    summary: "List items.",
    input: listInput,
    capabilities: {},
    stations: [
      station(commonCauses, {
        ...stationWords,
        commandIdentity: "x.list",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Items listed.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: "x.list:listed",
      }),
      station(commonCauses, {
        ...stationWords,
        commandIdentity: "x.list",
        causeCode: "DOMAIN_PRECONDITION_UNMET",
        trigger: "The list is unavailable.",
        repairAction: repairWords.inspect,
        guidance: { next: { kind: "command", command: "x.list", args: [] } },
        independentObservable: "x.list:unavailable",
      }),
    ],
    run: (input, context) => {
      if (input["--refuse"] === true)
        return context.result(
          {
            commandIdentity: "x.list",
            causeCode: "DOMAIN_PRECONDITION_UNMET",
          },
          {
            message: "The list is unavailable.",
            data: null,
            effects: unchanged,
          },
        );
      return context.result(
        {
          commandIdentity: "x.list",
          causeCode: "SUCCESS_UNCHANGED",
        },
        {
          message: "Listed items.",
          data: { items: ["alpha", "beta"] },
          effects: unchanged,
        },
      );
    },
  });
}

function archiveCommand() {
  return command({
    identity: "x.archive",
    route: ["archive", "all"],
    renamedFrom: [["old", "archive"], ["legacy-archive"]],
    summary: "Archive items.",
    input: emptyInput,
    capabilities: {},
    run: (_input, context) =>
      context.result(
        {
          commandIdentity: "x.archive",
          causeCode: "SUCCESS_UNCHANGED",
        },
        {
          message: "Archived items.",
          data: { archived: true },
          effects: unchanged,
        },
      ),
  });
}

function noticeContract() {
  return contractFor({
    cli: "x",
    commands: [listCommand(), archiveCommand()],
  });
}

async function runCli(
  contract: ReturnType<typeof noticeContract>,
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

async function parseWithoutRunId(
  contract: ReturnType<typeof noticeContract>,
  text: string,
) {
  const checked = await contract.validate(JSON.parse(text));
  if (!checked.ok)
    throw new Error(`Expected valid envelope: ${checked.reason}`);
  const envelope: Envelope = checked.value;
  const { runId: _runId, ...result } = envelope.result;
  void _runId;
  return { ...envelope, result };
}

const listStdout = [
  "Listed items.",
  JSON.stringify({ items: ["alpha", "beta"] }, null, 2),
  "",
].join("\n");

const archiveStdout = [
  "Archived items.",
  JSON.stringify({ archived: true }, null, 2),
  "",
].join("\n");

const renamedHelpStdout = [
  "x.list (inspect)",
  "List items.",
  "Renamed to `list`.",
  "Route: list",
  "Options:",
  "  --refuse  optional  Refuse the list request.",
  "Possible results:",
  "  success SUCCESS_UNCHANGED  Items listed.",
  "  refused DOMAIN_PRECONDITION_UNMET  The list is unavailable.",
  "  refused USAGE_INVALID_INVOCATION  Kernel USAGE_INVALID_INVOCATION.",
  "  refused SCHEMA_INVALID_INPUT  Kernel SCHEMA_INVALID_INPUT.",
  "  refused INTERNAL_PREPARATION  Kernel INTERNAL_PREPARATION.",
  "  failed INTERNAL_RESULT_UNCHANGED  Kernel INTERNAL_RESULT_UNCHANGED.",
  "",
].join("\n");

describe("renamedFrom human route notice", () => {
  test("running through an old route in human mode prints the Note line on stderr and keeps stdout identical", async () => {
    const contract = noticeContract();
    const viaOld = await runCli(contract, ["show", "all"]);
    const viaCurrent = await runCli(contract, ["list"]);
    expect(viaOld).toEqual({
      exit: 0,
      stdout: listStdout,
      stderr: 'Note: "show all" is now "list".\n',
    });
    expect(viaOld.stdout).toBe(viaCurrent.stdout);
  });

  test("running through an old route with --json keeps stderr empty and stdout envelope equal to the current route", async () => {
    const contract = noticeContract();
    const viaOld = await runCli(contract, ["show", "all", "--json"]);
    const viaCurrent = await runCli(contract, ["list", "--json"]);
    expect(viaOld.exit).toBe(0);
    expect(viaOld.stderr).toBe("");
    expect(await parseWithoutRunId(contract, viaOld.stdout)).toEqual(
      await parseWithoutRunId(contract, viaCurrent.stdout),
    );
  });

  test("running through the current route in human mode prints no Note line", async () => {
    const contract = noticeContract();
    const viaCurrent = await runCli(contract, ["list"]);
    expect(viaCurrent).toEqual({
      exit: 0,
      stdout: listStdout,
      stderr: "",
    });
  });

  test("running a refused command through an old route in human mode prints the Note line before the refusal line", async () => {
    const contract = noticeContract();
    const refusedViaOld = await runCli(contract, ["show", "all", "--refuse"]);
    const refusedViaCurrent = await runCli(contract, ["list", "--refuse"]);
    expect(refusedViaOld).toEqual({
      exit: 3,
      stdout: "",
      stderr:
        'Note: "show all" is now "list".\nx: The list is unavailable. [DOMAIN_PRECONDITION_UNMET]\n',
    });
    expect(refusedViaOld.exit).toBe(refusedViaCurrent.exit);

    const usageViaOld = await runCli(contract, ["show", "all", "--unknown"]);
    const usageViaCurrent = await runCli(contract, ["list", "--unknown"]);
    expect(usageViaOld).toEqual({
      exit: 2,
      stdout: "",
      stderr:
        'Note: "show all" is now "list".\nx: The invocation uses --unknown, an option this command does not declare. [USAGE_INVALID_INVOCATION]\n',
    });
    expect(usageViaOld.exit).toBe(usageViaCurrent.exit);
  });

  test("--help through an old route in human mode prints the Renamed to help line and no Note line", async () => {
    const contract = noticeContract();
    const helpViaOld = await runCli(contract, ["show", "all", "--help"]);
    expect(helpViaOld).toEqual({
      exit: 0,
      stdout: renamedHelpStdout,
      stderr: "",
    });
  });

  test("a command with two old routes prints each matched old route in its Note line", async () => {
    const contract = noticeContract();
    const first = await runCli(contract, ["old", "archive"]);
    const second = await runCli(contract, ["legacy-archive"]);
    expect(first).toEqual({
      exit: 0,
      stdout: archiveStdout,
      stderr: 'Note: "old archive" is now "archive all".\n',
    });
    expect(second).toEqual({
      exit: 0,
      stdout: archiveStdout,
      stderr: 'Note: "legacy-archive" is now "archive all".\n',
    });
  });
});
