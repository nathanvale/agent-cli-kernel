import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changing, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramResult } from "agent-cli-kernel";
import {
  callerProgramDisclosure,
  programDetails,
} from "agent-cli-kernel/addons/programs";
import {
  causes,
  completedSuccess,
  missingRunStation,
  noInput,
  nothingChanged,
  runArgument,
  scenarioArgument,
  stateStations,
  stationWords,
  unreadableStation,
} from "./causes.ts";
import { at, parsedJson } from "./json.ts";
import { failureText, refusalOf, unfinishedChange } from "./outcome.ts";
import type { State } from "./outcome.ts";
import { indexText, readIndex, runPlace, sha256, targetArgs } from "./place.ts";
import type { RunPlace, RunRow, StepRow } from "./place.ts";
import { placedStep, readScenario } from "./scenario.ts";
import type { Scenario, ScenarioStep } from "./scenario.ts";
import { limits } from "./target.ts";
import { creditOf, stepFile } from "./verdict.ts";
import type { FileSeen, Observed } from "./verdict.ts";

const identity = "verify-cli.drive";

export async function fileSeen(path: string): Promise<FileSeen> {
  try {
    return { content: await readFile(path, "utf8") };
  } catch (error) {
    if (at(error, "code") === "ENOENT") return { content: null };
    throw error;
  }
}

export function observedOf(ran: ProgramResult): Observed {
  return {
    exitCode: ran.exitCode,
    timedOut: programDetails(ran)?.timedOut ?? false,
    outputTruncated: ran.outputTruncated,
    terminationConfirmed: ran.terminationConfirmed,
    stdout: ran.stdout,
    stderr: ran.stderr,
  };
}

export function stepArgs(step: ScenarioStep, run: RunRow): readonly string[] {
  return step.runner === "bun"
    ? step.argv
    : targetArgs(join(run.repository, run.target), step.argv);
}

function stepText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type Written = { readonly row: StepRow; readonly content: string };

export async function keptStep(
  place: RunPlace,
  feature: string,
  step: ScenarioStep,
  ran: ProgramResult,
): Promise<Written> {
  const observed = observedOf(ran);
  const files = await Promise.all(
    (step.expect.files ?? []).map((file) => fileSeen(file.path)),
  );
  const kept = stepFile(feature, step, observed, files);
  const file = join(feature, `${step.name}.json`);
  const content = stepText(kept);
  const credit = creditOf(step, observed.stdout);
  return {
    row: {
      row: "step",
      feature,
      step: step.name,
      runner: step.runner,
      verdict: kept.verdict,
      commandIdentity: credit.commandIdentity,
      causeCode: credit.causeCode,
      exitCode: observed.exitCode,
      file,
      sha256: sha256(content),
    },
    content,
  };
}

async function confirmed(
  place: RunPlace,
  written: readonly Written[],
): Promise<boolean> {
  const read = readIndex(place);
  if (read.kind !== "read") return false;
  for (const entry of written) {
    const content = await readFile(
      join(place.evidence, entry.row.file),
      "utf8",
    );
    if (content !== entry.content) return false;
    if (!read.steps.some((row) => indexText([row]) === indexText([entry.row])))
      return false;
  }
  return true;
}

export type Blocked = "clean" | "driven" | undefined;

export function blockedEnding(
  blocked: Blocked,
  where: {
    readonly run: string;
    readonly feature: string;
    readonly scratch: string;
  },
) {
  if (blocked === "driven")
    return {
      causeCode: "DOMAIN_VERIFY_ALREADY_DRIVEN" as const,
      message: `The run at ${where.run} already holds steps of the feature ${where.feature}.`,
    };
  if (blocked === "clean")
    return {
      causeCode: "DOMAIN_VERIFY_RUN_CLEAN" as const,
      message: `Cleanup already removed ${where.scratch}.`,
    };
  return undefined;
}

export function driveCommand(state: State, bun: () => ParsedPath) {
  return changing({
    identity,
    route: ["drive"],
    summary: `Run every step of one scenario file against the run's target, and keep one evidence file and one index row for each. ${callerProgramDisclosure}`,
    input: { ...noInput, arguments: [runArgument, scenarioArgument] },
    capabilities: { programs: true, diagnostics: true },
    effectClass: "repository-local",
    effects: ["scenario.drive"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_VERIFY_RUN_HELD",
    unresolvedCaseCause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: completedSuccess,
        trigger: "Every step ran, was kept, and met its expectations.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Drive the next scenario file, or run report for this run.",
          },
        },
        independentObservable: `${identity}:met`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_EXPECTATION_UNMET",
        trigger:
          "Every step ran and was kept, and at least one step was unmet.",
        repairAction:
          "Read the evidence file of the step the message names; the feature fails there. Report it; never weaken the scenario.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The target did not do what the scenario expects.",
            inspect: [
              {
                kind: "instruction",
                text: "Read the unmet list in the evidence file the message names.",
              },
            ],
          },
        },
        independentObservable: `${identity}:unmet`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_SCENARIO",
        trigger: "The scenario file breaks one of the format's rules.",
        repairAction:
          "Repair the scenario file where the message's rule id says, then drive again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the scenario file; nothing ran.",
          },
        },
        independentObservable: `${identity}:scenario`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_ALREADY_DRIVEN",
        trigger: "The run's index already holds steps of this feature.",
        repairAction:
          "Launch a new run in another folder; an evidence file is never overwritten.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Launch a new run, then drive the scenario there.",
          },
        },
        independentObservable: `${identity}:already-driven`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_RUN_CLEAN",
        trigger: "Cleanup already removed the run's scratch folder.",
        repairAction: "Launch a new run in another folder to drive again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Launch a new run, then drive the scenario there.",
          },
        },
        independentObservable: `${identity}:clean`,
      }),
      missingRunStation(identity),
      unreadableStation(identity),
      ...stateStations(identity),
    ],
    run: async (input, context) => {
      const place = runPlace(input.run);
      const before = readIndex(place);
      if (before.kind === "missing")
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_MISSING" },
          {
            message: `${input.run} holds no run that launch made.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (before.kind === "unreadable")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
          },
          { message: before.reason, data: null, effects: nothingChanged },
        );
      const read = readScenario(input.scenario);
      if (read.kind === "broken")
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_SCENARIO" },
          {
            message: `The scenario breaks the rule ${read.rule}: ${read.detail}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const scenario: Scenario = read.scenario;
      const run = before.run;
      const places = { scratch: place.scratch, repository: run.repository };
      const steps = scenario.steps.map((step) => placedStep(step, places));
      let blocked: Blocked;
      let failure = "";
      const written: Written[] = [];
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: { resources: [{ resource: "run", key: input.run }] },
          facts: { run: input.run, feature: scenario.feature },
        },
        async (transaction) => {
          const current = readIndex(place);
          if (current.kind !== "read") {
            failure =
              current.kind === "unreadable"
                ? current.reason
                : "the index is gone";
            throw new Error(failure);
          }
          if (current.steps.some((row) => row.feature === scenario.feature)) {
            blocked = "driven";
            return;
          }
          if (!existsSync(place.scratch)) {
            blocked = "clean";
            return;
          }
          await transaction.record(
            "scenario.drive",
            async (effect) => {
              try {
                await mkdir(join(place.evidence, scenario.feature), {
                  recursive: true,
                });
                for (const step of steps) {
                  const ran = await context.programs.domain(effect).start({
                    executable: bun(),
                    args: [...stepArgs(step, run)],
                    timeoutMilliseconds: step.timeoutMilliseconds,
                    outputLimitBytes: step.outputLimitBytes,
                    shutdownMilliseconds: limits.shutdownMilliseconds,
                  });
                  context.diagnostics.record("drive.step", {
                    feature: scenario.feature,
                    step: step.name,
                    exitCode: ran.exitCode,
                    timedOut: programDetails(ran)?.timedOut ?? false,
                    terminationConfirmed: ran.terminationConfirmed,
                  });
                  const kept = await keptStep(
                    place,
                    scenario.feature,
                    step,
                    ran,
                  );
                  await writeFile(
                    join(place.evidence, kept.row.file),
                    kept.content,
                    {
                      flag: "wx",
                    },
                  );
                  await appendFile(place.index, indexText([kept.row]));
                  written.push(kept);
                }
              } catch (error) {
                failure = failureText(error);
                throw error;
              }
            },
            () => confirmed(place, written),
          );
        },
      );
      const ended =
        refusalOf(outcome, input.run) ??
        blockedEnding(blocked, {
          run: input.run,
          feature: scenario.feature,
          scratch: place.scratch,
        });
      if (ended !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: ended.causeCode },
          { message: ended.message, data: null, effects: nothingChanged },
        );
      if (
        outcome.proof.transactionState !== "completed" ||
        written.length !== steps.length
      ) {
        const ending = unfinishedChange(
          outcome.proof.transactionState,
          `Drive failed before it ran a step: ${failure}`,
          `The drive of ${scenario.feature} is unconfirmed after ${String(written.length)} of ${String(steps.length)} steps: ${failure}. Read the run's index.`,
        );
        return context.result(
          { commandIdentity: identity, causeCode: ending.causeCode },
          { message: ending.message, data: null, transaction: outcome.proof },
        );
      }
      const unmet = written.find((entry) => entry.row.verdict === "unmet");
      if (unmet !== undefined) {
        const file = join(place.evidence, unmet.row.file);
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_EXPECTATION_UNMET",
          },
          {
            message: `${String(written.filter((entry) => entry.row.verdict === "unmet").length)} of ${String(written.length)} steps unmet. First: ${unmet.row.step}, unmet at ${unmetList(unmet.content)}. Evidence: ${file}.`,
            data: null,
            transaction: outcome.proof,
          },
        );
      }
      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `${String(written.length)} steps met.`,
          data: {
            feature: scenario.feature,
            steps: written.map((entry) => ({
              step: entry.row.step,
              verdict: entry.row.verdict,
              file: join(place.evidence, entry.row.file),
            })),
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}

function unmetList(content: string): string {
  const unmet = at(parsedJson(content), "unmet");
  return Array.isArray(unmet) ? unmet.map(String).join(", ") : "";
}
