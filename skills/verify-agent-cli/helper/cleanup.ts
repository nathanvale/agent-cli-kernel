import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
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

const identity = "verify-agent-cli.cleanup";

export function cleanupCommand(state: State, root: string) {
  return changing({
    identity,
    route: ["cleanup"],
    summary:
      "Remove a run's scratch folder, and with it everything the target made there. The evidence folder stays.",
    input: { ...noInput, arguments: [runArgument] },
    capabilities: {},
    effectClass: "repository-local",
    effects: ["scratch.remove"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_VERIFY_RUN_HELD",
    unresolvedCaseCause: "DOMAIN_VERIFY_RUN_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: completedSuccess,
        trigger:
          "The run's scratch folder was removed and its evidence remains.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Run the evidence command with this run's name, and confirm every step's file is listed.",
          },
        },
        independentObservable: `${identity}:removed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_RUN_CLEAN",
        trigger: "The run's scratch folder was already gone.",
        repairAction: "Nothing to remove; read the run's evidence.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Run the evidence command with this run's name; its evidence is all there is.",
          },
        },
        independentObservable: `${identity}:already-clean`,
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
      ...stateStations(identity),
    ],
    run: async (input, context) => {
      const place = runPlace(root, input.run);
      if (!existsSync(place.evidence))
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_MISSING" },
          {
            message: `No run named ${input.run} under ${root}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      let clean = false;
      let failure = "";
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: { resources: [{ resource: "run", key: input.run }] },
          facts: { run: input.run, scratch: place.scratch },
        },
        async (transaction) => {
          try {
            clean = !existsSync(place.scratch);
          } catch (error) {
            failure = failureText(error);
            throw error;
          }
          if (clean) return;
          await transaction.record(
            "scratch.remove",
            () => rm(place.scratch, { recursive: true, force: true }),
            () =>
              Promise.resolve(
                !existsSync(place.scratch) && existsSync(place.record),
              ),
          );
        },
      );
      const refused = refusalOf(outcome, input.run);
      if (refused !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: nothingChanged },
        );
      const data = {
        run: input.run,
        removed: place.scratch,
        evidence: place.evidence,
      };
      if (clean)
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_CLEAN" },
          {
            message: `Run ${input.run} was already clean. Evidence: ${place.evidence}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (outcome.proof.transactionState !== "completed") {
        const ending = unfinishedChange(
          outcome.proof.transactionState,
          `Cleanup failed before it removed anything: ${failure}`,
          `Cleanup of run ${input.run} is unconfirmed: ${place.scratch} may be partly removed.`,
        );
        return context.result(
          { commandIdentity: identity, causeCode: ending.causeCode },
          { message: ending.message, data: null, transaction: outcome.proof },
        );
      }
      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Run ${input.run} is clean. Evidence: ${place.evidence}.`,
          data,
          transaction: outcome.proof,
        },
      );
    },
  });
}
