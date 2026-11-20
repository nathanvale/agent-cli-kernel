import { join } from "node:path";
import { contractFor, runInProcess, runProcess } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import { diagnosticsAddon } from "agent-cli-kernel/addons/diagnostics";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { causes, cli } from "./causes.ts";
import { cleanupCommand } from "./cleanup.ts";
import { doctorCommand } from "./doctor.ts";
import { driveCommand } from "./drive.ts";
import { evidenceCommand } from "./evidence.ts";
import { launchCommand } from "./launch.ts";
import { pendingCommand } from "./pending.ts";
import { findingsCommand, sweepCommand } from "./sweep.ts";
import { verificationFolder } from "./place.ts";
import type { Environment } from "./place.ts";

function located(name: string, environment: Environment): string {
  const found = Bun.which(name, { PATH: environment.PATH ?? "" });
  if (found === null)
    throw new Error(
      `${cli} needs ${name} on PATH to start the target. Repair: put the folder that holds ${name} on PATH.`,
    );
  return found;
}

export function helperContract(environment: Environment, cwd: string) {
  const root = verificationFolder(environment);
  const state = stateAddon({
    root: join(root, "state"),
    report: "verify-cli.pending",
  });
  const program =
    (path: string): (() => ParsedPath) =>
    () =>
      contract.boundary.path(path);
  const contract = contractFor({
    cli,
    commands: [
      launchCommand(state, root, cwd),
      doctorCommand(root, cwd, program(process.execPath)),
      sweepCommand(root, cwd, program(process.execPath)),
      findingsCommand(root, cwd, program(process.execPath)),
      driveCommand(state, root, program(located("env", environment))),
      evidenceCommand(root),
      cleanupCommand(state, root),
      pendingCommand(state),
    ],
    causes,
    state: state.descriptor,
    installedAddons: ["state", "programs", "diagnostics"],
  });
  const setup = (argv: readonly string[]) => ({
    emergencyRecord: state.emergencyRecord,
    addons: {
      programs: programsAddon(),
      diagnostics: diagnosticsAddon({
        cli,
        environment,
        argv: [...argv],
      }),
    },
  });
  return {
    root,
    contract,
    process: (argv: readonly string[]) =>
      runProcess(contract, setup(argv))(argv),
    inProcess: (argv: readonly string[]) =>
      runInProcess(contract, setup(argv))(argv),
  };
}

if (import.meta.main)
  await helperContract(process.env, process.cwd()).process(
    process.argv.slice(2),
  );
