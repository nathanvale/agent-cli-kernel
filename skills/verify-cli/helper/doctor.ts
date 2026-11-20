import { existsSync } from "node:fs";
import { join } from "node:path";
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
} from "./causes.ts";
import { at, listOf, readJsonFile } from "./json.ts";
import { entryFor, readRunRecord, runPlace } from "./place.ts";
import type { RunRecord } from "./place.ts";
import { envelopeOf } from "./transcript.ts";

const identity = "verify-cli.doctor";
const bounds = {
  timeoutMilliseconds: 30_000,
  outputLimitBytes: 1_048_576,
  shutdownMilliseconds: 2_000,
} as const;

type Listed = {
  readonly identity: string;
  readonly route: readonly string[];
  readonly effectClass: string;
};

function listed(entry: unknown): Listed | undefined {
  const name = at(entry, "commandIdentity");
  const effectClass = at(entry, "effectClass");
  const route = listOf(at(entry, "route")).filter(
    (word) => typeof word === "string",
  );
  return typeof name === "string" && typeof effectClass === "string"
    ? { identity: name, route: route.map(String), effectClass }
    : undefined;
}

function userCommands(found: unknown): Listed[] {
  return listOf(found)
    .map((entry) => listed(entry))
    .filter((entry) => entry !== undefined)
    .filter(
      (entry) =>
        entry.route.length > 0 &&
        !entry.route.some((word) => word.startsWith("-")),
    );
}

function fieldIn(
  path: string,
  names: readonly string[],
  absent: string,
): { readonly value: unknown; readonly failure: string | undefined } {
  const read = readJsonFile(path);
  if (read.kind === "unreadable")
    return { value: undefined, failure: read.reason };
  const value = read.kind === "read" ? at(read.value, ...names) : undefined;
  return {
    value,
    failure: read.kind === "missing" ? `${path} is missing` : absent,
  };
}

function packageFacts(cwd: string): {
  readonly pin: string | null;
  readonly failures: readonly string[];
} {
  const pin = fieldIn(
    join(cwd, "package.json"),
    ["dependencies", "agent-cli-kernel"],
    "package.json names no agent-cli-kernel dependency",
  );
  const installed = fieldIn(
    join(cwd, "node_modules", "agent-cli-kernel", "package.json"),
    ["name"],
    "node_modules/agent-cli-kernel is not the kernel package",
  );
  return {
    pin: typeof pin.value === "string" ? pin.value : null,
    failures: [
      ...(typeof pin.value === "string" ? [] : [pin.failure ?? ""]),
      ...(installed.value === "agent-cli-kernel"
        ? []
        : [installed.failure ?? ""]),
    ],
  };
}

function runFailures(
  root: string,
  run: string | undefined,
): { readonly failures: string[]; readonly record: RunRecord | undefined } {
  if (run === undefined) return { failures: [], record: undefined };
  const place = runPlace(root, run);
  try {
    const record = readRunRecord(place);
    if (record === undefined)
      return { failures: [`run ${run} was never launched`], record: undefined };
    return {
      failures: existsSync(place.scratch)
        ? []
        : [`run ${run} has no scratch folder: cleanup removed it`],
      record,
    };
  } catch (error) {
    return {
      failures: [error instanceof Error ? error.message : String(error)],
      record: undefined,
    };
  }
}

type Target = {
  readonly failures: string[];
  readonly cli: string;
  readonly commands: Listed[];
};

async function targetChecks(
  programs: ProgramsCapability,
  bun: ParsedPath,
  entry: string,
): Promise<Target> {
  if (!existsSync(entry))
    return { failures: [`${entry} does not exist`], cli: "", commands: [] };
  const ask = (...argv: string[]) =>
    programs.supplied({
      executable: bun,
      args: ["--no-install", entry, ...argv],
      ...bounds,
    });
  const failures: string[] = [];
  const help = await ask("--help");
  if (help.exitCode !== 0 || help.stdout === "" || help.stderr !== "")
    failures.push(
      `--help exited ${String(help.exitCode)} with ${String(help.stdout.length)} bytes of stdout and ${String(help.stderr.length)} of stderr`,
    );
  const unknown = await ask("verify-cli-no-such-command");
  if (unknown.exitCode !== 2)
    failures.push(
      `an unknown command exited ${String(unknown.exitCode)}; it must exit 2`,
    );
  if (
    unknown.stdout !== "" ||
    !/^[^\n]+ \[USAGE_UNKNOWN_COMMAND\]\n$/.test(unknown.stderr)
  )
    failures.push(
      "an unknown command must print nothing on stdout and one stderr line ending [USAGE_UNKNOWN_COMMAND]",
    );
  const discovery = await ask("--discover", "--json");
  const result = at(envelopeOf(discovery.stdout), "result");
  const named = at(result, "commandIdentity");
  const found = at(result, "data", "commands");
  if (
    discovery.exitCode === 0 &&
    discovery.stderr === "" &&
    typeof named === "string" &&
    named.endsWith(".discovery") &&
    Array.isArray(found)
  )
    return {
      failures,
      cli: named.slice(0, -".discovery".length),
      commands: userCommands(found),
    };
  failures.push(
    `--discover --json exited ${String(discovery.exitCode)} without one discovery envelope on stdout`,
  );
  return { failures, cli: "", commands: [] };
}

export function doctorCommand(
  root: string,
  cwd: string,
  bun: () => ParsedPath,
) {
  return command({
    identity,
    route: ["doctor"],
    summary: `Check that the target is worth driving: its kernel is installed, and its CLI answers help and discovery. ${callerProgramDisclosure}`,
    input: {
      ...noInput,
      options: [
        {
          name: "--run",
          aliases: [],
          summary:
            "Also check that this run exists and still has its scratch folder.",
          required: false,
          repeatable: false,
          value: nameRule,
        },
        {
          name: "--entry",
          aliases: [],
          summary:
            "The target's entry file, from the repository root. Default: the run's entry, or src/cli.ts.",
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
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger: "Every doctor check passed.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Pick a feature file and drive its first step.",
          },
        },
        independentObservable: `${identity}:healthy`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_DOCTOR_FAILED",
        trigger: "At least one doctor check failed.",
        repairAction:
          "Repair each failed check the message names, then run the doctor again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the failed checks; do not drive the target until the doctor passes.",
          },
        },
        independentObservable: `${identity}:unhealthy`,
      }),
    ],
    run: async (input, context) => {
      const run = runFailures(root, input["--run"]);
      const entryPath = entryFor(input["--entry"], run.record, cwd);
      const facts = packageFacts(cwd);
      const target = await targetChecks(context.programs, bun(), entryPath);
      const failed = [...facts.failures, ...run.failures, ...target.failures];
      if (failed.length > 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_DOCTOR_FAILED",
          },
          {
            message: `Doctor failed: ${failed.join("; ")}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `${target.cli} is worth driving: ${String(target.commands.length)} commands.`,
          data: {
            repository: cwd,
            pin: facts.pin,
            entry: entryPath,
            cli: target.cli,
            commands: target.commands.map((entry) => ({
              identity: entry.identity,
              route: [...entry.route],
              effectClass: entry.effectClass,
            })),
            run: input["--run"] ?? null,
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
