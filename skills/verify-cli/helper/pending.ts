import { command, station } from "agent-cli-kernel";
import type { State } from "./outcome.ts";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "./causes.ts";

const identity = "verify-cli.pending";

export function pendingCommand(state: State) {
  return command({
    identity,
    route: ["pending"],
    summary: "List the helper's changes that never finished.",
    input: noInput,
    capabilities: {},
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger: "The helper's state was read.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "A run named in the list stays blocked: keep its evidence and launch a new run under another name.",
          },
        },
        independentObservable: `${identity}:listed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_STATE_UNAVAILABLE",
        trigger: "The helper's state folder cannot be read.",
        repairAction:
          "Repair or move aside the state folder the message names.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The helper's state folder is unreadable or corrupt.",
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
    run: (_input, context) => {
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
            message: "0 unfinished changes: no change has run yet.",
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
          message: `The helper's state is ${report.reason}.`,
          data: null,
          effects: nothingChanged,
        },
      );
    },
  });
}
