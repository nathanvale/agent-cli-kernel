import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import { at, jsonFile, listOf } from "./json.ts";
import { readRunRecord, runPlace } from "./place.ts";
import { envelopeOf } from "./transcript.ts";

const identity = "verify-agent-cli.doctor";
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

function packageFailures(cwd: string): string[] {
  const pin = at(
    jsonFile(join(cwd, "package.json")),
    "dependencies",
    "agent-cli-kernel",
  );
  const installed = at(
    jsonFile(join(cwd, "node_modules", "agent-cli-kernel", "package.json")),
    "name",
  );
  return [
    ...(typeof pin === "string"
      ? []
      : ["package.json names no agent-cli-kernel dependency"]),
    ...(installed === "agent-cli-kernel"
      ? []
      : ["node_modules/agent-cli-kernel is not installed"]),
  ];
}

function runFailures(
  root: string,
  run: string | undefined,
): { readonly failures: string[]; readonly entry: string | undefined } {
  if (run === undefined) return { failures: [], entry: undefined };
  const place = runPlace(root, run);
  try {
    const record = readRunRecord(place);
    if (record === undefined)
      return { failures: [`run ${run} was never launched`], entry: undefined };
    return {
      failures: existsSync(place.scratch)
        ? []
        : [`run ${run} has no scratch folder: cleanup removed it`],
      entry: record.entry,
    };
  } catch (error) {
    return {
      failures: [error instanceof Error ? error.message : String(error)],
      entry: undefined,
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
  const unknown = await ask("verify-agent-cli-no-such-command");
  if (
    unknown.exitCode !== 2 ||
    unknown.stdout !== "" ||
    !unknown.stderr.endsWith("[USAGE_UNKNOWN_COMMAND]\n")
  )
    failures.push(
      `an unknown command exited ${String(unknown.exitCode)}; it must exit 2 with an empty stdout and one stderr line ending [USAGE_UNKNOWN_COMMAND]`,
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
      const entry = input["--entry"] ?? run.entry ?? "src/cli.ts";
      const entryPath = isAbsolute(entry) ? entry : join(cwd, entry);
      const target = await targetChecks(context.programs, bun(), entryPath);
      const failed = [
        ...packageFailures(cwd),
        ...run.failures,
        ...target.failures,
      ];
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
      const pin = at(
        jsonFile(join(cwd, "package.json")),
        "dependencies",
        "agent-cli-kernel",
      );
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `${target.cli} is worth driving: ${String(target.commands.length)} commands.`,
          data: {
            repository: cwd,
            pin: typeof pin === "string" ? pin : null,
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
