import { constants, existsSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
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
import {
  indexText,
  readIndex,
  verificationRun,
  sha256,
  targetArgs,
  targetLimits,
} from "./place.ts";
import type { VerificationRun, RunRow, StepRow } from "./place.ts";
import { gitAsk, repositoryFacts } from "./launch.ts";
import type { RepositoryFacts } from "./launch.ts";
import { placedStep, readScenario } from "./scenario.ts";
import type { Scenario, ScenarioStep } from "./scenario.ts";
import { stationOf, stepFile } from "./verdict.ts";
import type { FileSeen, StepRun } from "./verdict.ts";

const identity = "verify-cli.drive";

export const fileReadLimit = 1_048_576;

function notFile(kind: Exclude<FileSeen["kind"], "file">): FileSeen {
  return { kind, content: null };
}

type ParentCheck = "ok" | "symbolic-link" | "absent" | "unreadable";

type CheckResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "stop"; readonly status: Exclude<ParentCheck, "ok"> };

type CheckedPath = {
  readonly target: string;
  readonly realParent: string;
  readonly realRoot: string;
  readonly scratch?: string;
};

async function lstatTarget(
  target: string,
): Promise<CheckResult<Awaited<ReturnType<typeof lstat>>>> {
  try {
    const value = await lstat(target);
    return value.isSymbolicLink()
      ? { kind: "stop", status: "symbolic-link" }
      : { kind: "ok", value };
  } catch (error) {
    return {
      kind: "stop",
      status: linkCode(at(error, "code"))
        ? "symbolic-link"
        : errorStatus(error),
    };
  }
}

async function verifyScratchUnchanged(
  scratch: string,
  realRoot: string,
): Promise<ParentCheck> {
  const scratchNow = await resolveNonLink(scratch);
  if (scratchNow.kind !== "ok") return scratchNow.status;
  return scratchNow.value === realRoot ? "ok" : "symbolic-link";
}

async function verifyOpened(
  info: { readonly dev: number; readonly ino: number },
  checked: CheckedPath,
): Promise<ParentCheck> {
  if (checked.scratch !== undefined) {
    const scratchCheck = await verifyScratchUnchanged(
      checked.scratch,
      checked.realRoot,
    );
    if (scratchCheck !== "ok") return scratchCheck;
  }
  const entry = await lstatTarget(checked.target);
  if (entry.kind !== "ok") return entry.status;
  if (entry.value.dev !== info.dev || entry.value.ino !== info.ino)
    return "symbolic-link";
  const parentNow = await resolveReal(checked.realParent);
  if (parentNow.kind !== "ok") return parentNow.status;
  return parentNow.value === checked.realParent ? "ok" : "symbolic-link";
}

async function openedFile(
  handle: Awaited<ReturnType<typeof open>>,
  checked: CheckedPath,
  afterOpen?: () => void,
): Promise<FileSeen> {
  const info = await handle.stat();
  afterOpen?.();
  const verified = await verifyOpened(info, checked);
  if (verified !== "ok") return notFile(verified);
  if (info.isDirectory()) return notFile("folder");
  if (!info.isFile()) return notFile("other");
  if (info.size > fileReadLimit) return notFile("too-large");
  const buffer = Buffer.alloc(fileReadLimit + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
  if (bytesRead > fileReadLimit) return notFile("too-large");
  return {
    kind: "file",
    content: buffer.subarray(0, bytesRead).toString("utf8"),
  };
}

function absentCode(code: unknown): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

function linkCode(code: unknown): boolean {
  return code === "ELOOP" || code === "EMLINK";
}

function errorStatus(error: unknown): "absent" | "unreadable" {
  return absentCode(at(error, "code")) ? "absent" : "unreadable";
}

function relativeUnder(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    ? undefined
    : rel;
}

async function resolveReal(target: string): Promise<CheckResult<string>> {
  try {
    return { kind: "ok", value: await realpath(target) };
  } catch (error) {
    return { kind: "stop", status: errorStatus(error) };
  }
}

async function resolveNonLink(target: string): Promise<CheckResult<string>> {
  const entry = await lstatTarget(target);
  return entry.kind === "ok" ? resolveReal(target) : entry;
}

async function ancestorLinkUnder(
  realScratch: string,
  segments: readonly string[],
): Promise<ParentCheck> {
  let current = realScratch;
  for (const segment of segments) {
    current = join(current, segment);
    const entry = await lstatTarget(current);
    if (entry.kind !== "ok") return entry.status;
    if (!entry.value.isDirectory()) return "absent";
  }
  return "ok";
}

async function checkedScratchPath(
  realScratch: string,
  resolvedScratch: string,
  segments: readonly string[],
): Promise<CheckResult<CheckedPath>> {
  const parentSegments = segments.slice(0, -1);
  const walked = await ancestorLinkUnder(realScratch, parentSegments);
  if (walked !== "ok") return { kind: "stop", status: walked };
  const canonicalParent =
    segments.length === 0
      ? dirname(realScratch)
      : join(realScratch, ...parentSegments);
  const realParent = await resolveReal(canonicalParent);
  if (realParent.kind !== "ok") return realParent;
  if (realParent.value !== canonicalParent)
    return { kind: "stop", status: "symbolic-link" };
  return {
    kind: "ok",
    value: {
      target:
        segments.length === 0
          ? realScratch
          : join(realParent.value, ...segments.slice(-1)),
      realParent: realParent.value,
      realRoot: realScratch,
      scratch: resolvedScratch,
    },
  };
}

async function parentWithinScratch(
  path: string,
  scratch: string,
): Promise<CheckResult<CheckedPath>> {
  const resolvedScratch = resolve(scratch);
  const realScratch = await resolveNonLink(resolvedScratch);
  if (realScratch.kind !== "ok") return realScratch;
  const resolvedPath = resolve(path);
  const rel =
    relativeUnder(resolvedScratch, resolvedPath) ??
    relativeUnder(realScratch.value, resolvedPath);
  if (rel === undefined) return { kind: "stop", status: "symbolic-link" };
  return checkedScratchPath(
    realScratch.value,
    resolvedScratch,
    rel === "" ? [] : rel.split(sep),
  );
}

async function parentHasLink(
  target: string,
): Promise<CheckResult<CheckedPath>> {
  let current = dirname(target);
  while (dirname(current) !== current && dirname(current) !== sep) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        return { kind: "stop", status: "symbolic-link" };
    } catch (error) {
      if (!absentCode(at(error, "code")))
        return { kind: "stop", status: "unreadable" };
    }
    current = dirname(current);
  }
  const realParent = await resolveReal(dirname(target));
  if (realParent.kind !== "ok") return realParent;
  const leaf = basename(target);
  return {
    kind: "ok",
    value: {
      target: leaf === "" ? realParent.value : join(realParent.value, leaf),
      realParent: realParent.value,
      realRoot: realParent.value,
    },
  };
}

export async function fileSeen(
  path: string,
  scratch?: string,
  seam?: { readonly beforeOpen?: () => void; readonly afterOpen?: () => void },
): Promise<FileSeen> {
  const target = resolve(path);
  const parent =
    scratch === undefined
      ? await parentHasLink(target)
      : await parentWithinScratch(target, scratch);
  if (parent.kind !== "ok") return notFile(parent.status);
  const checked = parent.value;
  const pre = await lstatTarget(checked.target);
  if (pre.kind !== "ok") return notFile(pre.status);
  seam?.beforeOpen?.();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      checked.target,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    return notFile(
      linkCode(at(error, "code")) ? "symbolic-link" : errorStatus(error),
    );
  }
  try {
    return await openedFile(handle, checked, seam?.afterOpen);
  } catch (error) {
    return notFile(
      linkCode(at(error, "code")) ? "symbolic-link" : "unreadable",
    );
  } finally {
    await handle.close();
  }
}

export function stepRunOf(ran: ProgramResult): StepRun {
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
  feature: string,
  step: ScenarioStep,
  ran: ProgramResult,
  repository: RepositoryFacts,
  scratch?: string,
): Promise<Written> {
  const observed = stepRunOf(ran);
  const files = await Promise.all(
    (step.expect.files ?? []).map((file) => fileSeen(file.path, scratch)),
  );
  const kept = stepFile(feature, step, observed, files);
  const file = join(feature, `${step.name}.json`);
  const content = stepText({ ...kept, repository });
  const credit = stationOf(step, observed.stdout);
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
  place: VerificationRun,
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

export function driveCommand(
  state: State,
  bun: () => ParsedPath,
  git: () => ParsedPath | null,
) {
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
      const place = verificationRun(input.run);
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
      const repository = await repositoryFacts(
        gitAsk(context.programs, git()),
        run.repository,
      );
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
                    shutdownMilliseconds: targetLimits.shutdownMilliseconds,
                  });
                  context.diagnostics.record("drive.step", {
                    feature: scenario.feature,
                    step: step.name,
                    exitCode: ran.exitCode,
                    timedOut: programDetails(ran)?.timedOut ?? false,
                    terminationConfirmed: ran.terminationConfirmed,
                  });
                  const kept = await keptStep(
                    scenario.feature,
                    step,
                    ran,
                    repository,
                    place.scratch,
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
