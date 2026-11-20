import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { changing, station } from "agent-cli-kernel";
import {
  causes,
  completedSuccess,
  missingRunStation,
  noInput,
  nothingChanged,
  runArgument,
  stateStations,
  stationWords,
} from "./causes.ts";
import { failureText, refusalOf, unfinishedChange } from "./outcome.ts";
import type { State } from "./outcome.ts";
import { verificationRun } from "./place.ts";

const identity = "verify-cli.cleanup";

export function cleanupCommand(state: State) {
  return changing({
    identity,
    route: ["cleanup"],
    summary:
      "Remove a run's scratch folder, and with it everything a step left there. The evidence and state folders stay.",
    input: { ...noInput, arguments: [runArgument] },
    capabilities: { diagnostics: true },
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
          "The run's scratch folder was removed; its evidence and state remain.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Run report with this run's folder; it reads the evidence that remains.",
          },
        },
        independentObservable: `${identity}:removed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_VERIFY_RUN_CLEAN",
        trigger: "The run's scratch folder was already gone.",
        repairAction: "Nothing to remove; read the run's report.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Run report with this run's folder; its evidence is all there is.",
          },
        },
        independentObservable: `${identity}:already-clean`,
      }),
      missingRunStation(identity),
      ...stateStations(identity),
    ],
    run: async (input, context) => {
      const place = verificationRun(input.run);
      if (!existsSync(place.index) && !existsSync(place.state))
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_VERIFY_RUN_MISSING" },
          {
            message: `${input.run} holds no run that launch made.`,
            data: null,
            effects: nothingChanged,
          },
        );
      let clean = false;
      let launched = true;
      let failure = "";
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: { resources: [{ resource: "run", key: input.run }] },
          facts: { run: input.run, scratch: place.scratch },
        },
        async (transaction) => {
          if (!existsSync(place.index)) {
            launched = false;
            return;
          }
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
                !existsSync(place.scratch) && existsSync(place.index),
              ),
          );
        },
      );
      const blocked =
        refusalOf(outcome, input.run) ??
        (launched
          ? undefined
          : {
              causeCode: "DOMAIN_VERIFY_RUN_MISSING" as const,
              message: `${input.run} holds no run that launch made.`,
            }) ??
        (clean
          ? {
              causeCode: "DOMAIN_VERIFY_RUN_CLEAN" as const,
              message: `${place.scratch} was already removed. Kept: ${place.evidence} and ${place.state}.`,
            }
          : undefined);
      if (blocked !== undefined)
        return context.result(
          { commandIdentity: identity, causeCode: blocked.causeCode },
          { message: blocked.message, data: null, effects: nothingChanged },
        );
      if (outcome.proof.transactionState !== "completed") {
        const ending = unfinishedChange(
          outcome.proof.transactionState,
          `Cleanup failed before it removed anything: ${failure}`,
          `Cleanup of ${input.run} is unconfirmed: ${place.scratch} may be partly removed.`,
        );
        return context.result(
          { commandIdentity: identity, causeCode: ending.causeCode },
          { message: ending.message, data: null, transaction: outcome.proof },
        );
      }
      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Removed ${place.scratch}. Kept: ${place.evidence} and ${place.state}.`,
          data: {
            removed: [place.scratch],
            kept: [place.evidence, place.state],
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
