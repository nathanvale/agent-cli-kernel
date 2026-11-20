import { command, station } from "agent-cli-kernel";
import type { commonCauses, ParsedPath } from "agent-cli-kernel";
import { callerProgramDisclosure } from "agent-cli-kernel/addons/programs";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  targetArgument,
  unchangedSuccess,
} from "./causes.ts";
import { at, listOf } from "./json.ts";
import { discoveryProbe } from "./place.ts";
import {
  envelopeOf,
  kernelAdded,
  ownCommands,
  stringAt,
  targetRunner,
} from "./target.ts";
import type { TargetRunner, Listed } from "./target.ts";

export type Finding = {
  readonly check: string;
  readonly argv: readonly string[];
  readonly expected: string;
  readonly saw: string;
};

export type Station = {
  readonly command: string;
  readonly cause: string;
};

export type Swept = Station & { readonly check: string };

export type Sweep = {
  readonly contractVersion: string | null;
  readonly checks: number;
  readonly findings: readonly Finding[];
  readonly required: readonly Station[];
  readonly swept: readonly Swept[];
  readonly owed: readonly Station[];
};

const unknownWord = "verify-cli-no-such-command";
const unknownCommand =
  "USAGE_UNKNOWN_COMMAND" satisfies keyof typeof commonCauses;
const invalidInvocation =
  "USAGE_INVALID_INVOCATION" satisfies keyof typeof commonCauses;
const undeclaredOption = "--verify-cli-undeclared-option";

type Tally = {
  checks: number;
  readonly findings: Finding[];
};

function expecter(tally: Tally) {
  return (
    check: string,
    argv: readonly string[],
    expected: string,
    saw: string,
  ) => {
    tally.checks += 1;
    if (expected === saw) return true;
    tally.findings.push({ check, argv, expected, saw });
    return false;
  };
}

type Expect = ReturnType<typeof expecter>;

function oneLineEnding(stderr: string, cause: string): string {
  return String(new RegExp(`^[^\\n]+ \\[${cause}\\]\\n$`).test(stderr));
}

async function cliChecks(
  runTarget: TargetRunner,
  expect: Expect,
  hasEmptyRoute: boolean,
): Promise<void> {
  const helpArgv = ["--help"];
  const help = await runTarget(helpArgv);
  expect("help-exit", helpArgv, "0", String(help.exitCode));
  expect("help-stderr-empty", helpArgv, "", help.stderr);
  expect("help-usage-line", helpArgv, "Usage: ", help.stdout.slice(0, 7));
  if (hasEmptyRoute) return;
  const unknownArgv = [unknownWord];
  const unknown = await runTarget(unknownArgv);
  expect("unknown-command-exit", unknownArgv, "2", String(unknown.exitCode));
  expect("unknown-command-stdout-empty", unknownArgv, "", unknown.stdout);
  expect(
    "unknown-command-stderr-one-line-with-cause",
    unknownArgv,
    "true",
    oneLineEnding(unknown.stderr, unknownCommand),
  );
}

type CommandSweep = {
  readonly required: readonly Station[];
  readonly swept: readonly Swept[];
  readonly owed: readonly Station[];
};

async function commandChecks(
  runTarget: TargetRunner,
  expect: Expect,
  item: Listed,
): Promise<CommandSweep> {
  const identity = item.identity;
  const oneArgv = ["--discover-command", identity, "--json"];
  const one = await runTarget(oneArgv);
  const oneEnvelope = envelopeOf(one.stdout);
  const data = at(oneEnvelope, "result", "data");
  const discovered = [
    expect("command-discovery-exit", oneArgv, "0", String(one.exitCode)),
    expect(
      "command-discovery-one-envelope",
      oneArgv,
      "true",
      String(at(oneEnvelope, "result", "exitCode") === one.exitCode),
    ),
  ].every(Boolean);
  const stations = listOf(at(data, "stations"));
  const declared = stations.map((entry) => String(at(entry, "causeCode")));
  const seen = new Map<string, string>();

  const machineArgv = [...item.route, undeclaredOption, "--json"];
  const machine = await runTarget(machineArgv);
  const refusal = at(envelopeOf(machine.stdout), "result");
  const refusalCause = String(at(refusal, "causeCode"));
  const usageHeld = [
    expect("usage-exit", machineArgv, "2", String(machine.exitCode)),
    expect("usage-json-stderr-empty", machineArgv, "", machine.stderr),
    expect(
      "usage-envelope-exit-equals-process-exit",
      machineArgv,
      String(machine.exitCode),
      String(at(refusal, "exitCode")),
    ),
    expect(
      "usage-cause-is-declared",
      machineArgv,
      "true",
      String(declared.includes(refusalCause)),
    ),
    expect(
      "usage-cause-is-invalid-invocation",
      machineArgv,
      invalidInvocation,
      refusalCause,
    ),
  ].every(Boolean);
  if (discovered && usageHeld) seen.set(refusalCause, "usage-exit");

  const humanArgv = [...item.route, undeclaredOption];
  const human = await runTarget(humanArgv);
  expect("usage-human-exit", humanArgv, "2", String(human.exitCode));
  expect("usage-human-stdout-empty", humanArgv, "", human.stdout);
  expect(
    "usage-human-stderr-one-line-with-cause",
    humanArgv,
    "true",
    oneLineEnding(human.stderr, invalidInvocation),
  );

  const commandHelpArgv = [...item.route, "--help"];
  const commandHelp = await runTarget(commandHelpArgv);
  expect(
    "command-help-exit",
    commandHelpArgv,
    "0",
    String(commandHelp.exitCode),
  );

  const needsInput = [
    ...listOf(at(data, "input", "arguments")),
    ...listOf(at(data, "input", "options")),
  ].some((slot) => at(slot, "required") === true);
  if (item.effectClass === "inspect" && !needsInput) {
    const runArgv = [...item.route, "--json"];
    const ran = await runTarget(runArgv);
    const result = at(envelopeOf(ran.stdout), "result");
    const cause = String(at(result, "causeCode"));
    const runHeld = [
      expect("run-json-stderr-empty", runArgv, "", ran.stderr),
      expect(
        "run-envelope-exit-equals-process-exit",
        runArgv,
        String(ran.exitCode),
        String(at(result, "exitCode")),
      ),
      expect(
        "run-cause-is-declared",
        runArgv,
        "true",
        String(declared.includes(cause)),
      ),
      expect(
        "run-names-its-command",
        runArgv,
        identity,
        String(at(result, "commandIdentity")),
      ),
    ].every(Boolean);
    if (discovered && runHeld) seen.set(cause, "run-names-its-command");
  }

  const required = stations
    .filter((entry) => at(entry, "reachability") === "required")
    .map((entry) => ({
      command: identity,
      cause: String(at(entry, "causeCode")),
      trigger: String(at(entry, "trigger")),
    }))
    .filter((entry) => !kernelAdded(entry.cause, entry.trigger))
    .map(({ command, cause }) => ({ command, cause }));
  const swept = required.flatMap((entry) => {
    const check = seen.get(entry.cause);
    return check === undefined ? [] : [{ ...entry, check }];
  });
  return {
    required,
    swept,
    owed: required.filter((entry) => !seen.has(entry.cause)),
  };
}

export async function sweep(runTarget: TargetRunner): Promise<Sweep> {
  const tally: Tally = { checks: 0, findings: [] };
  const expect = expecter(tally);
  const discover = await runTarget(discoveryProbe);
  const discovery = envelopeOf(discover.stdout);
  const commands = ownCommands(discovery).own;
  await cliChecks(
    runTarget,
    expect,
    commands.some((item) => item.route.length === 0),
  );
  expect("discovery-exit", discoveryProbe, "0", String(discover.exitCode));
  expect("discovery-stderr-empty", discoveryProbe, "", discover.stderr);
  expect(
    "discovery-one-envelope",
    discoveryProbe,
    "true",
    String(at(discovery, "result", "exitCode") === discover.exitCode),
  );
  expect(
    "discovery-lists-a-command",
    discoveryProbe,
    "true",
    String(commands.length > 0),
  );
  const required: Station[] = [];
  const swept: Swept[] = [];
  const owed: Station[] = [];
  for (const item of commands) {
    const one = await commandChecks(runTarget, expect, item);
    required.push(...one.required);
    swept.push(...one.swept);
    owed.push(...one.owed);
  }
  return {
    contractVersion: stringAt(discovery, "contractVersion"),
    checks: tally.checks,
    findings: tally.findings,
    required,
    swept,
    owed,
  };
}

const sweepIdentity = "verify-cli.sweep";
const findingsIdentity = "verify-cli.findings";

function firstFinding(found: Sweep): string {
  const first = found.findings[0];
  return first === undefined
    ? ""
    : ` First: ${first.check} on ${JSON.stringify(first.argv)}: expected ${JSON.stringify(first.expected)}, saw ${JSON.stringify(first.saw)}.`;
}

export function sweepCommand(bun: () => ParsedPath) {
  return command({
    identity: sweepIdentity,
    route: ["sweep"],
    summary: `Run every check the target's own discovery implies: help, usage refusals, exit codes and streams. ${callerProgramDisclosure}`,
    input: { ...noInput, arguments: [targetArgument] },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: sweepIdentity,
        causeCode: unchangedSuccess,
        trigger: "Every check the target's discovery implies passed.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Drive each owed result through a scenario; the sweep cannot reach them.",
          },
        },
        independentObservable: `${sweepIdentity}:clean`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: sweepIdentity,
        causeCode: "DOMAIN_VERIFY_FINDINGS",
        trigger: "At least one check the target's discovery implies failed.",
        repairAction:
          "Run the findings command for the whole list, repair the target or its installed kernel, then sweep again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Run findings with the same target to list every failed check.",
          },
        },
        independentObservable: `${sweepIdentity}:findings`,
      }),
    ],
    run: async (input, context) => {
      const found = await sweep(
        targetRunner(context.programs, bun(), input.target),
      );
      if (found.findings.length > 0)
        return context.result(
          {
            commandIdentity: sweepIdentity,
            causeCode: "DOMAIN_VERIFY_FINDINGS",
          },
          {
            message: `${String(found.findings.length)} of ${String(found.checks)} checks failed.${firstFinding(found)}`,
            data: null,
            effects: nothingChanged,
          },
        );
      return context.result(
        { commandIdentity: sweepIdentity, causeCode: unchangedSuccess },
        {
          message: `${String(found.checks)} checks passed. Stations owed: ${String(found.owed.length)}.`,
          data: {
            contractVersion: found.contractVersion,
            checks: found.checks,
            swept: found.swept.map((entry) => ({ ...entry })),
            owed: found.owed.map((entry) => ({ ...entry })),
          },
          effects: nothingChanged,
        },
      );
    },
  });
}

export function findingsCommand(bun: () => ParsedPath) {
  return command({
    identity: findingsIdentity,
    route: ["findings"],
    summary: `List every finding of the same sweep as data, whether or not it passed. ${callerProgramDisclosure}`,
    input: { ...noInput, arguments: [targetArgument] },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: findingsIdentity,
        causeCode: unchangedSuccess,
        trigger: "The sweep ran and its findings are listed.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair each finding in the target or its installed kernel, then sweep again.",
          },
        },
        independentObservable: `${findingsIdentity}:listed`,
      }),
    ],
    run: async (input, context) => {
      const found = await sweep(
        targetRunner(context.programs, bun(), input.target),
      );
      return context.result(
        { commandIdentity: findingsIdentity, causeCode: unchangedSuccess },
        {
          message: `${String(found.findings.length)} findings from ${String(found.checks)} checks.`,
          data: {
            checks: found.checks,
            findings: found.findings.map((entry) => ({
              ...entry,
              argv: [...entry.argv],
            })),
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
