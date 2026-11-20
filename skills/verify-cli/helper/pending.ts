import { existsSync } from "node:fs";
import { command, station } from "agent-cli-kernel";
import {
  causes,
  missingRunStation,
  noInput,
  nothingChanged,
  runArgument,
  stationWords,
  unchangedSuccess,
} from "./causes.ts";
import type { State } from "./outcome.ts";
import { runPlace } from "./place.ts";

const identity = "verify-cli.pending";

export function pendingCommand(state: State) {
  return command({
    identity,
    route: ["pending"],
    summary:
      "List the helper's changes to one run that never finished. The run's folder is required; it is optional in the input only because the state add-on names this command with no arguments.",
    input: {
      ...noInput,
      arguments: [{ ...runArgument, required: false }],
    },
    capabilities: {},
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger: "The run's state was read.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "A run with an unfinished change stays held: keep its folder as evidence and launch a new run in another folder.",
          },
        },
        independentObservable: `${identity}:listed`,
      }),
      missingRunStation(identity),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
        trigger: "The run's state folder cannot be read.",
        repairAction:
          "Repair or move aside the state folder the message names.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The run's state folder is unreadable or corrupt.",
            inspect: [
              {
                kind: "instruction",
                text: "Read the state folder the message names.",
              },
            ],
          },
        },
        independentObservable: `${identity}:state-unreadable`,
      }),
    ],
    run: (input, context) => {
      const run = input.run;
      if (run === undefined || !existsSync(runPlace(run).index))
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_MISSING" },
          {
            message:
              run === undefined
                ? "Name the run's folder: pending reads one run's state."
                : `${run} holds no run that launch made.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const report = state.report();
      if (report.ok)
        return context.result(
          { commandIdentity: identity, causeCode: unchangedSuccess },
          {
            message: `${String(report.unfinished.length)} unfinished changes.`,
            data: {
              unfinished: report.unfinished.map((entry) => ({
                operationId: entry.operationId,
                commandIdentity: entry.commandIdentity,
                effects: [...entry.effects],
              })),
            },
            effects: nothingChanged,
          },
        );
      if (report.reason === "missing")
        return context.result(
          { commandIdentity: identity, causeCode: unchangedSuccess },
          {
            message: "0 unfinished changes.",
            data: { unfinished: [] },
            effects: nothingChanged,
          },
        );
      return context.result(
        {
          commandIdentity: identity,
          causeCode: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
        },
        {
          message: `The state at ${runPlace(run).state} is ${report.reason}.`,
          data: null,
          effects: nothingChanged,
        },
      );
    },
  });
}
