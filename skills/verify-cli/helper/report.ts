import { join } from "node:path";
import { command, station } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import { callerProgramDisclosure } from "agent-cli-kernel/addons/programs";
import {
  causes,
  missingRunStation,
  noInput,
  nothingChanged,
  runArgument,
  stationWords,
  unchangedSuccess,
  unreadableStation,
} from "./causes.ts";
import { at, listOf, readJsonFile } from "./json.ts";
import { readIndex, verificationRun } from "./place.ts";
import type { VerificationRun, StepRow } from "./place.ts";
import { sweep } from "./sweep.ts";
import type { Station, Sweep } from "./sweep.ts";
import { targetDrive } from "./target.ts";

const identity = "verify-cli.report";

export type StationState = Station & {
  readonly state: "swept" | "driven" | "owed";
  readonly by: string | null;
};

export function stationStates(
  found: Sweep,
  steps: readonly StepRow[],
): readonly StationState[] {
  return found.required.map((entry) => {
    const step = steps.find(
      (row) =>
        row.verdict === "met" &&
        row.runner === "target" &&
        row.commandIdentity === entry.command &&
        row.causeCode === entry.cause,
    );
    if (step !== undefined)
      return { ...entry, state: "driven", by: `${step.feature}/${step.step}` };
    const swept = found.swept.find(
      (seen) => seen.command === entry.command && seen.cause === entry.cause,
    );
    if (swept !== undefined)
      return { ...entry, state: "swept", by: swept.check };
    return { ...entry, state: "owed", by: null };
  });
}

export type StepDetail = {
  readonly step: string;
  readonly unmet: readonly string[];
  readonly terminationConfirmed: boolean;
};

export type Details =
  | { readonly kind: "read"; readonly steps: readonly StepDetail[] }
  | { readonly kind: "unreadable"; readonly reason: string };

export function stepDetails(
  place: VerificationRun,
  steps: readonly StepRow[],
): Details {
  const details: StepDetail[] = [];
  for (const row of steps) {
    const path = join(place.evidence, row.file);
    const read = readJsonFile(path);
    if (read.kind !== "read")
      return {
        kind: "unreadable",
        reason: read.kind === "missing" ? `${path} is missing` : read.reason,
      };
    const unmet = listOf(at(read.value, "unmet")).map(String);
    details.push({
      step: `${row.feature}/${row.step}`,
      unmet,
      terminationConfirmed:
        at(read.value, "observed", "terminationConfirmed") === true,
    });
  }
  return { kind: "read", steps: details };
}

export function reportCommand(bun: () => ParsedPath) {
  return command({
    identity,
    route: ["report"],
    summary: `Give each required station of the target one state, swept, driven or owed, and list the run's unmet steps and unconfirmed process ends. ${callerProgramDisclosure}`,
    input: { ...noInput, arguments: [runArgument] },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger: "The run's index was read and the target was swept.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Write a scenario for each owed station, or say in its feature file why it stays owed.",
          },
        },
        independentObservable: `${identity}:reported`,
      }),
      missingRunStation(identity),
      unreadableStation(identity),
    ],
    run: async (input, context) => {
      const place = verificationRun(input.run);
      const read = readIndex(place);
      if (read.kind === "missing")
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_MISSING" },
          {
            message: `${input.run} holds no run that launch made.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const details =
        read.kind === "read" ? stepDetails(place, read.steps) : read;
      if (read.kind !== "read" || details.kind !== "read")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
          },
          {
            message: details.kind === "unreadable" ? details.reason : "",
            data: null,
            effects: nothingChanged,
          },
        );
      const found = await sweep(
        targetDrive(
          context.programs,
          bun(),
          join(read.run.repository, read.run.target),
        ),
      );
      const states = stationStates(found, read.steps);
      const count = (state: StationState["state"]) =>
        String(states.filter((entry) => entry.state === state).length);
      const unmet = details.steps.filter((step) => step.unmet.length > 0);
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `Stations: ${count("swept")} swept, ${count("driven")} driven, ${count("owed")} owed. Steps: ${String(details.steps.length - unmet.length)} met, ${String(unmet.length)} unmet.`,
          data: {
            stations: states.map((entry) => ({ ...entry })),
            unmet: unmet.map((step) => ({
              step: step.step,
              unmet: [...step.unmet],
            })),
            unconfirmed: details.steps
              .filter((step) => !step.terminationConfirmed)
              .map((step) => step.step),
            findings: found.findings.length,
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
