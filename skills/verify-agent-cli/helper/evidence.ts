import { existsSync } from "node:fs";
import { command, station } from "agent-cli-kernel";
import {
  causes,
  noInput,
  nothingChanged,
  runArgument,
  stationWords,
  unchangedSuccess,
  unreadableStation,
} from "./causes.ts";
import { runPlace } from "./place.ts";
import { readSteps } from "./steps.ts";

const identity = "verify-agent-cli.evidence";

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
      unreadableStation(identity),
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
      const { steps, unreadable } = readSteps(place.evidence);
      if (unreadable.length > 0)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_VERIFY_EVIDENCE_UNREADABLE",
          },
          {
            message: `Run ${input.run} holds evidence the helper cannot read: ${unreadable.join("; ")}.`,
            data: null,
            effects: nothingChanged,
          },
        );
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
