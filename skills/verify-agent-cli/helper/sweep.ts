import { existsSync } from "node:fs";
import { command, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { callerProgramDisclosure } from "agent-cli-kernel/addons/programs";
import {
  causes,
  nameRule,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
  unreadableStation,
} from "./causes.ts";
import { at, listOf, parsedJson } from "./json.ts";
import { entryFor, readRunRecord, runPlace } from "./place.ts";
import { readSteps } from "./steps.ts";

type Ran = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};
type Drive = (argv: readonly string[]) => Promise<Ran>;
type Finding = {
  readonly check: string;
  readonly argv: readonly string[];
  readonly expected: string;
  readonly saw: string;
};
type Result = { readonly command: string; readonly cause: string };

type Sweep = {
  readonly contractVersion: string;
  readonly checks: number;
  readonly findings: readonly Finding[];
  readonly observed: readonly Result[];
  readonly owed: readonly Result[];
  readonly notDriven: readonly {
    readonly command: string;
    readonly why: string;
  }[];
};

const unknownWord = "verify-agent-cli-no-such-command";
const undeclaredOption = "--verify-agent-cli-undeclared-option";

function words(value: unknown): readonly string[] {
  return listOf(value)
    .filter((item) => typeof item === "string")
    .map(String);
}

type Driven =
  | { readonly kind: "read"; readonly results: readonly Result[] }
  | { readonly kind: "unreadable"; readonly reasons: readonly string[] };

function driven(root: string, run: string | undefined): Driven {
  if (run === undefined) return { kind: "read", results: [] };
  const evidence = runPlace(root, run).evidence;
  if (!existsSync(evidence)) return { kind: "read", results: [] };
  const { steps, unreadable } = readSteps(evidence);
  if (unreadable.length > 0) return { kind: "unreadable", reasons: unreadable };
  return {
    kind: "read",
    results: steps
      .filter((step) => step.contractHeld)
      .flatMap((step) =>
        step.commandIdentity === null || step.causeCode === null
          ? []
          : [{ command: step.commandIdentity, cause: step.causeCode }],
      ),
  };
}

async function sweep(drive: Drive, already: readonly Result[]): Promise<Sweep> {
  const findings: Finding[] = [];
  const observed: Result[] = [];
  const owed: Result[] = [];
  const notDriven: { command: string; why: string }[] = [];
  let checks = 0;
  const expect = (
    check: string,
    argv: readonly string[],
    expected: string,
    saw: string,
  ) => {
    checks += 1;
    if (expected !== saw) findings.push({ check, argv, expected, saw });
  };

  const helpArgv = ["--help"];
  const help = await drive(helpArgv);
  expect("help-exit", helpArgv, "0", String(help.exitCode));
  expect("help-stderr-empty", helpArgv, "", help.stderr);
  expect("help-usage-line", helpArgv, "Usage: ", help.stdout.slice(0, 7));

  const unknownArgv = [unknownWord];
  const unknown = await drive(unknownArgv);
  expect("unknown-command-exit", unknownArgv, "2", String(unknown.exitCode));
  expect("unknown-command-stdout-empty", unknownArgv, "", unknown.stdout);
  expect(
    "unknown-command-stderr-one-line-with-cause",
    unknownArgv,
    "true",
    String(/^[^\n]+ \[USAGE_UNKNOWN_COMMAND\]\n$/.test(unknown.stderr)),
  );

  const discoverArgv = ["--discover", "--json"];
  const discover = await drive(discoverArgv);
  const discovery = parsedJson(discover.stdout);
  expect("discovery-exit", discoverArgv, "0", String(discover.exitCode));
  expect("discovery-stderr-empty", discoverArgv, "", discover.stderr);
  const commands = listOf(at(discovery, "result", "data", "commands")).filter(
    (item) => {
      const route = words(at(item, "route"));
      return route.length > 0 && !route.some((word) => word.startsWith("-"));
    },
  );
  expect(
    "discovery-lists-a-command",
    discoverArgv,
    "true",
    String(commands.length > 0),
  );

  for (const item of commands) {
    const identity = String(at(item, "commandIdentity"));
    const route = words(at(item, "route"));
    const oneArgv = ["--discover-command", identity, "--json"];
    const one = await drive(oneArgv);
    const data = at(parsedJson(one.stdout), "result", "data");
    expect("command-discovery-exit", oneArgv, "0", String(one.exitCode));
    const stations = listOf(at(data, "stations"));
    const declared = stations.map((entry) => String(at(entry, "causeCode")));
    const seen = new Set(
      already
        .filter((entry) => entry.command === identity)
        .map((entry) => entry.cause),
    );

    const machineArgv = [...route, undeclaredOption, "--json"];
    const machine = await drive(machineArgv);
    const refusal = at(parsedJson(machine.stdout), "result");
    const refusalCause = String(at(refusal, "causeCode"));
    expect("usage-exit", machineArgv, "2", String(machine.exitCode));
    expect("usage-json-stderr-empty", machineArgv, "", machine.stderr);
    expect(
      "usage-envelope-exit-equals-process-exit",
      machineArgv,
      String(machine.exitCode),
      String(at(refusal, "exitCode")),
    );
    expect(
      "usage-cause-is-declared",
      machineArgv,
      "true",
      String(declared.includes(refusalCause)),
    );
    seen.add(refusalCause);

    const humanArgv = [...route, undeclaredOption];
    const human = await drive(humanArgv);
    expect("usage-human-exit", humanArgv, "2", String(human.exitCode));
    expect("usage-human-stdout-empty", humanArgv, "", human.stdout);
    expect(
      "usage-human-stderr-one-line-with-cause",
      humanArgv,
      "true",
      String(/^[^\n]+ \[USAGE_INVALID_INVOCATION\]\n$/.test(human.stderr)),
    );

    const commandHelpArgv = [...route, "--help"];
    const commandHelp = await drive(commandHelpArgv);
    expect(
      "command-help-exit",
      commandHelpArgv,
      "0",
      String(commandHelp.exitCode),
    );
    expect(
      "command-help-stderr-empty",
      commandHelpArgv,
      "",
      commandHelp.stderr,
    );

    const needsInput = [
      ...listOf(at(data, "input", "arguments")),
      ...listOf(at(data, "input", "options")),
    ].some((slot) => at(slot, "required") === true);
    const effectClass = String(at(item, "effectClass"));
    if (effectClass !== "inspect")
      notDriven.push({
        command: identity,
        why: `it changes things (${effectClass}); drive it in a run`,
      });
    else if (needsInput)
      notDriven.push({
        command: identity,
        why: "it needs input; drive it in a run",
      });
    else {
      const runArgv = [...route, "--json"];
      const ran = await drive(runArgv);
      const result = at(parsedJson(ran.stdout), "result");
      const cause = String(at(result, "causeCode"));
      expect("run-json-stderr-empty", runArgv, "", ran.stderr);
      expect(
        "run-envelope-exit-equals-process-exit",
        runArgv,
        String(ran.exitCode),
        String(at(result, "exitCode")),
      );
      expect(
        "run-cause-is-declared",
        runArgv,
        "true",
        String(declared.includes(cause)),
      );
      expect(
        "run-names-its-command",
        runArgv,
        identity,
        String(at(result, "commandIdentity")),
      );
      seen.add(cause);
    }

    for (const entry of stations) {
      const cause = String(at(entry, "causeCode"));
      if (seen.has(cause)) observed.push({ command: identity, cause });
      else if (
        at(entry, "reachability") === "required" &&
        !String(at(entry, "trigger")).startsWith("Kernel ")
      )
        owed.push({ command: identity, cause });
    }
  }

  return {
    contractVersion: String(at(discovery, "contractVersion")),
    checks,
    findings,
    observed,
    owed,
    notDriven,
  };
}

const targetOptions = {
  ...noInput,
  options: [
    {
      name: "--entry",
      aliases: [],
      summary:
        "The target's entry file, from the repository root. Default: src/cli.ts.",
      required: false,
      repeatable: false,
      value: {
        kind: "string",
        minLength: 1,
        maxLength: 1024,
        choices: null,
        pattern: null,
      },
    },
    {
      name: "--run",
      aliases: [],
      summary:
        "Count the results this run's drive steps already reached as driven.",
      required: false,
      repeatable: false,
      value: nameRule,
    },
  ],
} as const;

type Swept =
  | { readonly kind: "swept"; readonly report: Sweep }
  | { readonly kind: "unreadable"; readonly reasons: readonly string[] };

async function sweeper(
  root: string,
  cwd: string,
  bun: () => ParsedPath,
  programs: ProgramsCapability,
  entry: string | undefined,
  run: string | undefined,
): Promise<Swept> {
  let target: string;
  try {
    const record =
      run === undefined ? undefined : readRunRecord(runPlace(root, run));
    target = entryFor(entry, record, cwd);
  } catch (error) {
    return {
      kind: "unreadable",
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
  const already = driven(root, run);
  if (already.kind === "unreadable") return already;
  const report = await sweep(async (argv) => {
    const ran = await programs.supplied({
      executable: bun(),
      args: ["--no-install", target, ...argv],
      timeoutMilliseconds: 30_000,
      outputLimitBytes: 1_048_576,
      shutdownMilliseconds: 2_000,
    });
    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr };
  }, already.results);
  return { kind: "swept", report };
}

function unreadableMessage(reasons: readonly string[]): string {
  return `The run's evidence cannot be read: ${reasons.join("; ")}.`;
}

const sweepIdentity = "verify-agent-cli.sweep";
const findingsIdentity = "verify-agent-cli.findings";

export function sweepCommand(root: string, cwd: string, bun: () => ParsedPath) {
  return command({
    identity: sweepIdentity,
    route: ["sweep"],
    summary: `Run every check the target's own discovery implies: help, usage refusals, exit codes and streams. ${callerProgramDisclosure}`,
    input: targetOptions,
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
            text: "Drive each result in owed through a feature's scenario; the sweep cannot reach them.",
          },
        },
        independentObservable: `${sweepIdentity}:clean`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: sweepIdentity,
        causeCode: "DOMAIN_VERIFY_SWEEP_FAILED",
        trigger: "At least one check the target's discovery implies failed.",
        repairAction:
          "Run the findings command for the whole list, repair the target or its installed kernel, then sweep again.",
        guidance: {
          next: {
            kind: "command",
            command: findingsIdentity,
            args: [],
          },
        },
        independentObservable: `${sweepIdentity}:failed`,
      }),
      unreadableStation(sweepIdentity),
    ],
    run: async (input, context) => {
      const swept = await sweeper(
        root,
        cwd,
        bun,
        context.programs,
        input["--entry"],
        input["--run"],
      );
      if (swept.kind === "unreadable")
        return context.result(
          {
            commandIdentity: sweepIdentity,
            causeCode: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
          },
          {
            message: unreadableMessage(swept.reasons),
            data: null,
            effects: nothingChanged,
          },
        );
      const report = swept.report;
      const first = report.findings[0];
      if (first !== undefined)
        return context.result(
          {
            commandIdentity: sweepIdentity,
            causeCode: "DOMAIN_VERIFY_SWEEP_FAILED",
          },
          {
            message: `${String(report.findings.length)} of ${String(report.checks)} checks failed. First: ${first.check} on ${JSON.stringify(first.argv)}: expected ${JSON.stringify(first.expected)}, saw ${JSON.stringify(first.saw)}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      return context.result(
        { commandIdentity: sweepIdentity, causeCode: unchangedSuccess },
        {
          message: `${String(report.checks)} checks passed. ${String(report.owed.length)} declared results still need a scenario.`,
          data: {
            contractVersion: report.contractVersion,
            checks: report.checks,
            observed: report.observed.map((entry) => ({ ...entry })),
            owed: report.owed.map((entry) => ({ ...entry })),
            notDriven: report.notDriven.map((entry) => ({ ...entry })),
          },
          effects: nothingChanged,
        },
      );
    },
  });
}

export function findingsCommand(
  root: string,
  cwd: string,
  bun: () => ParsedPath,
) {
  return command({
    identity: findingsIdentity,
    route: ["findings"],
    summary: `List every finding of the same sweep as data, whether or not it passed. ${callerProgramDisclosure}`,
    input: targetOptions,
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
            text: "Repair each finding in the target or its installed kernel, then run the sweep command again.",
          },
        },
        independentObservable: `${findingsIdentity}:listed`,
      }),
      unreadableStation(findingsIdentity),
    ],
    run: async (input, context) => {
      const swept = await sweeper(
        root,
        cwd,
        bun,
        context.programs,
        input["--entry"],
        input["--run"],
      );
      if (swept.kind === "unreadable")
        return context.result(
          {
            commandIdentity: findingsIdentity,
            causeCode: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
          },
          {
            message: unreadableMessage(swept.reasons),
            data: null,
            effects: nothingChanged,
          },
        );
      const report = swept.report;
      return context.result(
        { commandIdentity: findingsIdentity, causeCode: unchangedSuccess },
        {
          message: `${String(report.findings.length)} findings from ${String(report.checks)} checks.`,
          data: {
            checks: report.checks,
            findings: report.findings.map((entry) => ({
              ...entry,
              argv: [...entry.argv],
            })),
            owed: report.owed.map((entry) => ({ ...entry })),
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
