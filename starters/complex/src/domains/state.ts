import { resolve } from "node:path";
import { recordDiagnostic } from "../diagnostics.ts";
import {
  completed,
  inspected,
  invalidInput,
  invalidPersistedState,
  journalLockHeld,
  parseSetArguments,
  previewed,
  priorRunPending,
  recovered,
} from "../engine.ts";
import {
  InvalidStateDocumentError,
  inspectRecovery,
  inspectState,
  setState,
} from "../runtime.ts";
import type { OperationResult } from "../commands-contract.ts";

function statePath(): string {
  return resolve(process.env.CLI_EXAMPLE_STATE ?? "example-state.json");
}

export async function execute(
  command: string,
  args: string[],
): Promise<OperationResult> {
  if (command === "status") {
    await recordDiagnostic("example.status");
    let result: ReturnType<typeof inspected>;
    try {
      result = inspected(await inspectState(statePath()));
    } catch (error) {
      if (!(error instanceof InvalidStateDocumentError)) throw error;
      result = invalidPersistedState();
    }
    return result;
  }
  if (command === "recover") {
    await recordDiagnostic("example.recover");
    const result = recovered(await inspectRecovery(statePath()));
    return result;
  }
  if (command === "set") {
    const parsed = parseSetArguments(args);
    if (!parsed.success) {
      const result = invalidInput("The set value is invalid.");
      return result;
    }
    await recordDiagnostic("example.set");
    const result = parsed.data.preview
      ? previewed(parsed.data.value)
      : await (async () => {
          const state = await setState(statePath(), parsed.data.value);
          if (state.status === "locked") return journalLockHeld();
          if (state.status === "blocked") {
            return priorRunPending();
          }
          if (state.status === "unchanged") {
            const result = previewed(parsed.data.value);
            result.data = { preview: false, value: parsed.data.value };
            result.message =
              "The requested value is already present; it was not replayed.";
            return result;
          }
          return completed(parsed.data.value, state.effectId);
        })();
    return result;
  }
  return invalidInput("Choose a declared state command.");
}
