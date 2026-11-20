import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { command, station } from "agent-cli-kernel";
import {
  causes,
  noInput,
  nothingChanged,
  runArgument,
  stationWords,
  unchangedSuccess,
} from "./causes.ts";
import { at, jsonFile, listOf } from "./json.ts";
import { runPlace } from "./place.ts";

const identity = "verify-agent-cli.evidence";

type Step = {
  readonly step: string;
  readonly file: string;
  readonly startedAt: string;
  readonly exitCode: number | null;
  readonly causeCode: string | null;
  readonly unmet: number;
};

function stepOf(folder: string, name: string): Step {
  const file = join(folder, name);
  const parsed = jsonFile(file);
  const exitCode = at(parsed, "exitCode");
  const causeCode = at(parsed, "causeCode");
  const startedAt = at(parsed, "startedAt");
  const checks = at(parsed, "checks");
  return {
    step: name.slice(0, -".json".length),
    file,
    startedAt: typeof startedAt === "string" ? startedAt : "",
    exitCode: typeof exitCode === "number" ? exitCode : null,
    causeCode: typeof causeCode === "string" ? causeCode : null,
    unmet: listOf(checks).filter((check) => at(check, "met") !== true).length,
  };
}

export function evidenceCommand(root: string) {
  return command({
    identity,
    route: ["evidence"],
    summary: "List a run's evidence files, which cleanup never removes.",
    input: { ...noInput, arguments: [runArgument] },
    capabilities: {},
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger: "The run's evidence folder was read.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${identity}:listed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_RUN_MISSING",
        trigger: "No run has this name.",
        repairAction: "Name a run that launch made.",
        guidance: {
          next: {
            kind: "instruction",
            text: "List the run folders under the helper's runs folder and choose one.",
          },
        },
        independentObservable: `${identity}:run-missing`,
      }),
    ],
    run: (input, context) => {
      const place = runPlace(root, input.run);
      if (!existsSync(place.record))
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_MISSING" },
          {
            message: `No run named ${input.run} under ${root}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const steps = readdirSync(place.evidence)
        .filter((name) => name.endsWith(".json") && name !== "run.json")
        .map((name) => stepOf(place.evidence, name))
        .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `Run ${input.run} holds ${String(steps.length)} steps in ${place.evidence}.`,
          data: {
            run: input.run,
            evidence: place.evidence,
            record: place.record,
            scratch: existsSync(place.scratch) ? "present" : "removed",
            steps: steps.map((step) => ({ ...step })),
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
