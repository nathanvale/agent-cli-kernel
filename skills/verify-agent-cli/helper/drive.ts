import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { changing, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramResult } from "agent-cli-kernel";
import {
  callerProgramDisclosure,
  programDetails,
} from "agent-cli-kernel/addons/programs";
import {
  causes,
  nameRule,
  noInput,
  nothingChanged,
  runArgument,
  stateStations,
  stationWords,
  completedSuccess,
} from "./causes.ts";
import { at } from "./json.ts";
import { failureText, refusalOf, unfinishedChange } from "./outcome.ts";
import type { State } from "./outcome.ts";
import { readRunRecord, runPlace } from "./place.ts";
import type { RunPlace, RunRecord } from "./place.ts";
import {
  causeOf,
  checks,
  contractChecks,
  envelopeOf,
  identityOf,
} from "./transcript.ts";
import type { Check, Expectations } from "./transcript.ts";

const identity = "verify-agent-cli.drive";
const outputLimitBytes = 1_048_576;
const shutdownMilliseconds = 2_000;

const textOption = <const Name extends string, const Repeat extends boolean>(
  name: Name,
  summary: string,
  repeatable: Repeat,
) =>
  ({
    name,
    aliases: [],
    summary,
    required: false,
    repeatable,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 4096,
      choices: null,
      pattern: null,
    },
  }) as const;

function argvOf(text: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const words: string[] = [];
  for (const item of Array.from(parsed, (entry: unknown) => entry)) {
    if (typeof item !== "string") return undefined;
    words.push(item);
  }
  return words;
}

function targetCommand(
  record: RunRecord,
  place: RunPlace,
  argv: readonly string[],
  script: boolean,
): readonly string[] {
  const home = place.home;
  const where = script
    ? [`--cwd=${record.repository}`, "run", ...argv]
    : ["--no-install", `--cwd=${place.scratch}`, record.entry, ...argv];
  return [
    `HOME=${home}`,
    `XDG_STATE_HOME=${join(home, ".local", "state")}`,
    `XDG_CONFIG_HOME=${join(home, ".config")}`,
    `XDG_DATA_HOME=${join(home, ".local", "share")}`,
    `XDG_CACHE_HOME=${join(home, ".cache")}`,
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    process.execPath,
    ...where,
  ];
}

type Driven = {
  readonly step: string;
  readonly argv: readonly string[];
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly elapsedMilliseconds: number;
  readonly exitCode: number | null;
  readonly terminationConfirmed: boolean;
  readonly timedOut: boolean;
  readonly signal: string | number | null;
  readonly outputTruncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly oneEnvelope: boolean;
  readonly commandIdentity: string | null;
  readonly causeCode: string | null;
  readonly file: KeptFile | null;
  readonly scratchChanges: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly truncated: boolean;
  };
  readonly checks: readonly Check[];
  readonly contract: readonly Check[];
};

const listingLimit = 500;

async function listing(folder: string): Promise<readonly string[]> {
  try {
    const names = await readdir(folder, { recursive: true });
    return names.map(String).sort();
  } catch {
    return [];
  }
}

function changes(before: readonly string[], after: readonly string[]) {
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  return {
    added: added.slice(0, listingLimit),
    removed: removed.slice(0, listingLimit),
    truncated: added.length > listingLimit || removed.length > listingLimit,
  };
}

type KeptFile = {
  readonly path: string;
  readonly text: string | null;
  readonly problem: string | null;
};

async function fileText(place: RunPlace, path: string): Promise<KeptFile> {
  const full = isAbsolute(path) ? path : join(place.scratch, path);
  try {
    return { path: full, text: await readFile(full, "utf8"), problem: null };
  } catch (error) {
    return {
      path: full,
      text: null,
      problem:
        at(error, "code") === "ENOENT"
          ? "absent"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

type StepFacts = {
  readonly step: string;
  readonly argv: readonly string[];
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly started: number;
  readonly script: boolean;
  readonly scratchChanges: Driven["scratchChanges"];
  readonly file: KeptFile | null;
  readonly expected: Expectations;
};

function keptStep(ran: ProgramResult, facts: StepFacts): Driven {
  const envelope = envelopeOf(ran.stdout);
  const timedOut = programDetails(ran)?.timedOut ?? false;
  const seen = {
    exitCode: ran.exitCode,
    stdout: ran.stdout,
    stderr: ran.stderr,
    file: facts.file?.text ?? null,
  };
  return {
    step: facts.step,
    argv: facts.argv,
    command: facts.command,
    startedAt: facts.startedAt,
    elapsedMilliseconds: Math.round(performance.now() - facts.started),
    exitCode: ran.exitCode,
    terminationConfirmed: ran.terminationConfirmed,
    timedOut,
    signal: programDetails(ran)?.signal ?? null,
    outputTruncated: ran.outputTruncated,
    stdout: ran.stdout,
    stderr: ran.stderr,
    oneEnvelope: envelope !== null,
    commandIdentity: identityOf(envelope),
    causeCode: causeOf(envelope, ran.stderr),
    file: facts.file,
    scratchChanges: facts.scratchChanges,
    checks: checks(facts.expected, seen),
    contract: contractChecks(seen, facts.argv, {
      script: facts.script,
      timedOut,
    }),
  };
}

function traceOf(ran: ProgramResult, run: string) {
  const details = programDetails(ran);
  return {
    run,
    pid: details?.pid ?? null,
    exitCode: ran.exitCode,
    timedOut: details?.timedOut ?? false,
    signal: details?.signal ?? null,
    attempts: (details?.attempts ?? []).map((attempt) => ({
      signal: attempt.signal,
      afterMilliseconds: attempt.afterMilliseconds,
    })),
    terminationConfirmed: ran.terminationConfirmed,
  };
}

function evidenceText(driven: Driven): string {
  return `${JSON.stringify(driven, null, 2)}\n`;
}

export function driveCommand(
  state: State,
  root: string,
  env: () => ParsedPath,
) {
  return changing({
    identity,
    route: ["drive"],
    summary: `Run the target once inside a run, and keep what a user would see as one evidence file. ${callerProgramDisclosure}`,
    input: {
      ...noInput,
      arguments: [
        runArgument,
        {
          name: "step",
          summary:
            "The step's name, unique in its run; it names the evidence file.",
          required: true,
          value: nameRule,
        },
        {
          name: "argv",
          summary:
            'The words to give the target, as one JSON array of strings, such as \'["status","--json"]\'.',
          required: true,
          value: {
            kind: "string",
            minLength: 2,
            maxLength: 16_384,
            choices: null,
            pattern: null,
          },
        },
      ],
      options: [
        {
          name: "--timeout-ms",
          aliases: [],
          summary:
            "Stop the target after this many milliseconds. Default: 30000.",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 1, maximum: 600_000 },
        },
        {
          name: "--expect-exit",
          aliases: [],
          summary: "The exit code the target must end with.",
          required: false,
          repeatable: false,
          value: { kind: "integer", minimum: 0, maximum: 255 },
        },
        textOption(
          "--expect-cause",
          "The cause code the target's envelope, or its one stderr line, must name.",
          false,
        ),
        textOption(
          "--expect-stdout",
          "Text the target's stdout must hold. Repeat it for more texts.",
          true,
        ),
        textOption(
          "--expect-stderr",
          "Text the target's stderr must hold. Repeat it for more texts.",
          true,
        ),
        {
          name: "--expect-empty-stdout",
          aliases: [],
          summary: "The target must write nothing to stdout.",
          required: false,
          repeatable: false,
          value: null,
        },
        {
          name: "--expect-empty-stderr",
          aliases: [],
          summary: "The target must write nothing to stderr.",
          required: false,
          repeatable: false,
          value: null,
        },
        textOption("--stdin", "Text to write to the target's stdin.", false),
        {
          name: "--script",
          aliases: [],
          summary:
            'Run a package.json script in the repository root instead of the target\'s entry file: argv starts with its name, such as ["check"].',
          required: false,
          repeatable: false,
          value: null,
        },
        textOption(
          "--read-file",
          "After the target ends, keep this file's text in the evidence. A relative path is read from the run's scratch folder.",
          false,
        ),
        textOption(
          "--expect-file",
          "Text the file named by --read-file must hold.",
          false,
        ),
      ],
    },
    capabilities: { programs: true, diagnostics: true },
    effectClass: "repository-local",
    effects: ["step.run", "step.write"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_VERIFY_RUN_HELD",
    unresolvedCaseCause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: completedSuccess,
        trigger:
          "The target ran, its evidence was kept, and every expectation held.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Drive the feature's next step, or run cleanup when the feature is proved.",
          },
        },
        independentObservable: `${identity}:driven`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_EXPECTATION_UNMET",
        trigger:
          "The target ran and its evidence was kept, but an expectation did not hold.",
        repairAction:
          "Read the evidence file: the feature fails there. Report it; never weaken the expectation.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The target did not do what the feature expects.",
            inspect: [
              {
                kind: "instruction",
                text: "Read the checks in the evidence file the message names.",
              },
            ],
          },
        },
        independentObservable: `${identity}:expectation-unmet`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_RUN_MISSING",
        trigger:
          "No run has this name, or cleanup already removed its scratch folder.",
        repairAction: "Launch a run under a new name.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Launch a run under a new name, then drive the step in it.",
          },
        },
        independentObservable: `${identity}:run-missing`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_STEP_EXISTS",
        trigger: "This run already holds evidence for a step with this name.",
        repairAction:
          "Name the step something new; evidence is never overwritten.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Drive again with a step name this run has not used.",
          },
        },
        independentObservable: `${identity}:step-exists`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_ARGV_INVALID",
        trigger: "The argv argument is not a JSON array of strings.",
        repairAction:
          'Quote the target\'s words as one JSON array of strings, such as \'["status","--json"]\'.',
        guidance: {
          next: {
            kind: "command",
            command: "verify-agent-cli.command-discovery",
            args: ["verify-agent-cli.drive"],
          },
        },
        independentObservable: `${identity}:argv-invalid`,
      }),
      ...stateStations(identity),
    ],
    run: async (input, context) => {
      const argv = argvOf(input.argv);
      if (argv === undefined)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_ARGV_INVALID",
          },
          {
            message: `The argv argument ${input.argv} is not a JSON array of strings.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const place = runPlace(root, input.run);
      const file = join(place.evidence, `${input.step}.json`);
      const expected: Expectations = {
        exitCode: input["--expect-exit"],
        causeCode: input["--expect-cause"],
        stdout: input["--expect-stdout"] ?? [],
        stderr: input["--expect-stderr"] ?? [],
        emptyStdout: input["--expect-empty-stdout"] === true,
        emptyStderr: input["--expect-empty-stderr"] === true,
        file: input["--expect-file"],
      };
      const stdin = input["--stdin"];
      let blocked: "missing" | "step" | undefined;
      let failure = "";
      let driven: Driven | undefined;
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: { resources: [{ resource: "run", key: input.run }] },
          facts: { run: input.run, step: input.step, argv: [...argv] },
        },
        async (transaction) => {
          let record: RunRecord | undefined;
          try {
            record = readRunRecord(place);
          } catch (error) {
            failure = failureText(error);
            throw error;
          }
          if (record === undefined || !existsSync(place.scratch)) {
            blocked = "missing";
            return;
          }
          if (existsSync(file)) {
            blocked = "step";
            return;
          }
          const command = targetCommand(
            record,
            place,
            argv,
            input["--script"] === true,
          );
          const before = await listing(place.scratch);
          const startedAt = new Date().toISOString();
          const started = performance.now();
          const ran: ProgramResult = await transaction.record(
            "step.run",
            (effect) =>
              context.programs.domain(effect).start({
                executable: env(),
                args: command,
                input:
                  stdin === undefined
                    ? undefined
                    : new TextEncoder().encode(stdin),
                timeoutMilliseconds: input["--timeout-ms"] ?? 30_000,
                outputLimitBytes,
                shutdownMilliseconds,
              }),
            (result) => Promise.resolve(result.terminationConfirmed),
          );
          const read = input["--read-file"];
          const kept = keptStep(ran, {
            step: input.step,
            argv,
            command,
            startedAt,
            started,
            script: input["--script"] === true,
            scratchChanges: changes(before, await listing(place.scratch)),
            file: read === undefined ? null : await fileText(place, read),
            expected,
          });
          context.diagnostics.record("drive.target", traceOf(ran, input.run));
          await transaction.record(
            "step.write",
            () => writeFile(file, evidenceText(kept), { flag: "wx" }),
            async () => (await readFile(file, "utf8")) === evidenceText(kept),
          );
          driven = kept;
        },
      );
      const refused = refusalOf(outcome, input.run);
      if (refused !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: nothingChanged },
        );
      if (blocked === "missing")
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_MISSING" },
          {
            message: `Run ${input.run} was never launched, or cleanup removed its scratch folder.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (blocked === "step")
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_STEP_EXISTS" },
          {
            message: `Run ${input.run} already holds ${file}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const proved = driven;
      if (
        outcome.proof.transactionState !== "completed" ||
        proved === undefined
      ) {
        const ending = unfinishedChange(
          outcome.proof.transactionState,
          `Drive failed before it started the target: ${failure}`,
          `Step ${input.step} of run ${input.run} is unconfirmed: the target's stop or its evidence file ${file} could not be confirmed.`,
        );
        return context.result(
          { commandIdentity: identity, causeCode: ending.causeCode },
          { message: ending.message, data: null, transaction: outcome.proof },
        );
      }
      const unmet = [...proved.contract, ...proved.checks].filter(
        (check) => !check.met,
      );
      if (unmet.length > 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_EXPECTATION_UNMET",
          },
          {
            message: `Step ${input.step} failed ${unmet.map((check) => check.expectation).join(", ")}. Evidence: ${file}.`,
            data: null,
            transaction: outcome.proof,
          },
        );
      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Step ${input.step} ran; ${String(proved.checks.length)} expectations held. Evidence: ${file}.`,
          data: {
            step: input.step,
            evidence: file,
            exitCode: proved.exitCode,
            causeCode: proved.causeCode,
            oneEnvelope: proved.oneEnvelope,
            expectations: proved.checks.length,
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
