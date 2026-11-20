import { contractFor, runInProcess, runProcess } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import { diagnosticsAddon } from "agent-cli-kernel/addons/diagnostics";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { causes, cli } from "./causes.ts";
import { cleanupCommand } from "./cleanup.ts";
import { driveCommand } from "./drive.ts";
import { launchCommand } from "./launch.ts";
import { pendingCommand } from "./pending.ts";
import { verificationRun } from "./place.ts";
import { probeCommand, readyCommand } from "./ready.ts";
import { reportCommand } from "./report.ts";
import { findingsCommand, sweepCommand } from "./sweep.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

const runCommands = ["launch", "drive", "report", "cleanup", "pending"];
const unboundState = "verify-cli-names-no-run";

export function stateRoot(argv: readonly string[]): string {
  const folder = argv.slice(1).find((word) => !word.startsWith("-"));
  return runCommands.includes(argv[0] ?? "") &&
    folder !== undefined &&
    folder.startsWith("/")
    ? verificationRun(folder).state
    : unboundState;
}

export function helperContract(
  environment: Environment,
  argv: readonly string[],
) {
  const state = stateAddon({
    root: stateRoot(argv),
    report: "verify-cli.pending",
  });
  const bun = (): ParsedPath => contract.boundary.path(process.execPath);
  const git = (): ParsedPath | null => {
    const found = Bun.which("git", { PATH: environment.PATH ?? "" });
    return found === null ? null : contract.boundary.path(found);
  };
  const contract = contractFor({
    cli,
    commands: [
      readyCommand(bun),
      probeCommand(bun),
      sweepCommand(bun),
      findingsCommand(bun),
      launchCommand(state, git),
      driveCommand(state, bun),
      reportCommand(bun),
      cleanupCommand(state),
      pendingCommand(state),
    ],
    causes,
    state: state.descriptor,
    installedAddons: ["state", "programs", "diagnostics"],
  });
  const setup = {
    emergencyRecord: state.emergencyRecord,
    addons: {
      programs: programsAddon(),
      diagnostics: diagnosticsAddon({
        cli,
        environment,
        argv: [...argv],
      }),
    },
  };
  return {
    contract,
    process: () => runProcess(contract, setup)(argv),
    inProcess: () => runInProcess(contract, setup)(argv),
  };
}

if (import.meta.main)
  await helperContract(process.env, process.argv.slice(2)).process();
