import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { changing, station } from "agent-cli-kernel";
import {
  causes,
  noInput,
  nothingChanged,
  runArgument,
  stateStations,
  stationWords,
  completedSuccess,
} from "./causes.ts";
import { failureText, refusalOf, unfinishedChange } from "./outcome.ts";
import type { State } from "./outcome.ts";
import { runPlace } from "./place.ts";
import type { RunRecord } from "./place.ts";

const identity = "verify-cli.launch";

function recordText(record: RunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function launchCommand(state: State, root: string, cwd: string) {
  return changing({
    identity,
    route: ["launch"],
    summary:
      "Make a run: an empty scratch folder the target runs in, and an evidence folder that cleanup keeps.",
    input: {
      ...noInput,
      arguments: [runArgument],
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
      ],
    },
    capabilities: {},
    effectClass: "repository-local",
    effects: ["run.create"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_VERIFY_RUN_HELD",
    unresolvedCaseCause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: completedSuccess,
        trigger: "The run's scratch and evidence folders exist.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Run the doctor command with this run's name, then drive one feature.",
          },
        },
        independentObservable: `${identity}:run-made`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_RUN_EXISTS",
        trigger: "A run with this name was launched before.",
        repairAction:
          "Choose a new run name; a run's evidence is never reused.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Launch again under a name no earlier run used.",
          },
        },
        independentObservable: `${identity}:run-exists`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_TARGET_MISSING",
        trigger:
          "The folder the helper runs in has no package.json, no installed kernel, or no entry file.",
        repairAction:
          "Run the helper from the generated repository's root after bun install, and name its entry file with --entry.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Change to the repository root, run bun install --frozen-lockfile, then launch again.",
          },
        },
        independentObservable: `${identity}:target-missing`,
      }),
      ...stateStations(identity),
    ],
    run: async (input, context) => {
      const place = runPlace(root, input.run);
      const entry = input["--entry"] ?? "src/cli.ts";
      const entryPath = isAbsolute(entry) ? entry : join(cwd, entry);
      const missing = [
        join(cwd, "package.json"),
        join(cwd, "node_modules", "agent-cli-kernel", "package.json"),
        entryPath,
      ].filter((path) => !existsSync(path));
      if (missing.length > 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_TARGET_MISSING",
          },
          {
            message: `Missing from ${cwd}: ${missing.map((path) => relative(cwd, path)).join(", ")}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const record: RunRecord = {
        run: input.run,
        repository: cwd,
        entry: entryPath,
        launchedAt: new Date().toISOString(),
      };
      let existed = false;
      let failure = "";
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: { resources: [{ resource: "run", key: input.run }] },
          facts: { run: input.run, folder: place.folder },
        },
        async (transaction) => {
          try {
            if (existsSync(place.folder)) {
              existed = true;
              return;
            }
          } catch (error) {
            failure = failureText(error);
            throw error;
          }
          await transaction.record(
            "run.create",
            async () => {
              await mkdir(place.home, { recursive: true });
              await mkdir(place.evidence, { recursive: true });
              await writeFile(place.record, recordText(record), { flag: "wx" });
            },
            async () =>
              existsSync(place.home) &&
              (await readFile(place.record, "utf8")) === recordText(record),
          );
        },
      );
      const refused = refusalOf(outcome, input.run);
      if (refused !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: nothingChanged },
        );
      if (existed)
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_EXISTS" },
          {
            message: `Run ${input.run} already exists at ${place.folder}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (outcome.proof.transactionState !== "completed") {
        const ending = unfinishedChange(
          outcome.proof.transactionState,
          `Launch failed before it made anything: ${failure}`,
          `Run ${input.run} may be half made at ${place.folder}.`,
        );
        return context.result(
          { commandIdentity: identity, causeCode: ending.causeCode },
          { message: ending.message, data: null, transaction: outcome.proof },
        );
      }
      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Run ${input.run} is ready. Evidence goes to ${place.evidence}.`,
          data: {
            run: input.run,
            repository: cwd,
            entry: entryPath,
            scratch: place.scratch,
            evidence: place.evidence,
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
