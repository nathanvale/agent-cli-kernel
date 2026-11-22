import { carriesGlobalSwitch } from "../routing.ts";
import { exits } from "../types.ts";
import { diagnostics } from "./diagnostics.ts";
import type {
  CauseRow,
  CauseTable,
  Effects,
  Envelope,
  FailureClass,
  Handoff,
  NextStep,
  ResultFor,
  WireResult,
  TransactionState,
  Outcome,
} from "../types.ts";
import {
  integer,
  json,
  keys,
  record,
  sortedStrings,
  text,
} from "./primitives.ts";

export function causeRow(value: unknown): value is CauseRow {
  if (
    !record(value) ||
    !keys(value, [
      "outcome",
      "transactionState",
      "failureClass",
      "exitCode",
      "retryable",
      "guidance",
    ])
  )
    return false;
  if (value.outcome === "success") return successRow(value);
  if (
    !failure(value.failureClass) ||
    value.exitCode !== exits[value.failureClass]
  )
    return false;
  if (value.outcome !== "refused" && value.outcome !== "failed") return false;
  if (value.failureClass === "transient")
    return (
      value.transactionState === "unchanged" &&
      value.retryable === true &&
      value.guidance === "next"
    );
  if (
    value.retryable !== false ||
    (value.guidance !== "next" && value.guidance !== "handoff")
  )
    return false;
  return nonTransientRow(value);
}
function successRow(value: Record<string, unknown>): boolean {
  return (
    (value.transactionState === "unchanged" ||
      value.transactionState === "completed") &&
    value.failureClass === null &&
    value.exitCode === 0 &&
    value.retryable === false &&
    value.guidance === "next"
  );
}
function nonTransientRow(value: Record<string, unknown>): boolean {
  if (value.outcome === "refused")
    return value.transactionState === "unchanged";
  if (value.failureClass === "usage") return false;
  return (
    value.transactionState === "unchanged" ||
    (value.guidance === "handoff" &&
      (value.transactionState === "completed" ||
        value.transactionState === "partially-completed" ||
        value.transactionState === "unknown"))
  );
}
function failure(value: unknown): value is FailureClass {
  return (
    value === "internal" ||
    value === "usage" ||
    value === "domain" ||
    value === "schema" ||
    value === "transient"
  );
}
export function effects(value: unknown): value is Effects {
  if (
    !record(value) ||
    !keys(value, ["completed", "remaining", "uncertain", "inventoryComplete"])
  )
    return false;
  if (
    !sortedStrings(value.completed) ||
    !sortedStrings(value.remaining) ||
    !sortedStrings(value.uncertain) ||
    typeof value.inventoryComplete !== "boolean"
  )
    return false;
  const all = [...value.completed, ...value.remaining, ...value.uncertain];
  return new Set(all).size === all.length;
}
function effectState(value: WireResult): boolean {
  const e = value.effects;
  if (value.effectClass === "inspect")
    return (
      value.transactionState === "unchanged" &&
      e.inventoryComplete &&
      e.completed.length + e.remaining.length + e.uncertain.length === 0
    );
  return transactionEffects(value.transactionState, e, value.outcome);
}
export function transactionEffects(
  state: TransactionState,
  e: Effects,
  outcome: Outcome,
): boolean {
  switch (state) {
    case "unchanged":
      return (
        e.inventoryComplete &&
        e.completed.length === 0 &&
        e.uncertain.length === 0 &&
        (outcome !== "success" || e.remaining.length === 0)
      );
    case "completed":
      return (
        e.inventoryComplete &&
        e.completed.length > 0 &&
        e.remaining.length === 0 &&
        e.uncertain.length === 0
      );
    case "partially-completed":
      return (
        e.inventoryComplete &&
        e.completed.length > 0 &&
        e.remaining.length > 0 &&
        e.uncertain.length === 0
      );
    case "unknown":
      return !e.inventoryComplete || e.uncertain.length > 0;
  }
}
export function nextStep(value: unknown): value is NextStep {
  if (!record(value)) return false;
  switch (value.kind) {
    case "command":
      return (
        keys(value, ["kind", "command", "args"]) &&
        text(value.command) &&
        Array.isArray(value.args) &&
        value.args.every((arg: unknown) => typeof arg === "string") &&
        !carriesGlobalSwitch(value.args)
      );
    case "instruction":
      return keys(value, ["kind", "text"]) && text(value.text);
    case "retry":
    case "done":
      return keys(value, ["kind"]);
    default:
      return false;
  }
}
export function handoff(value: unknown): value is Handoff {
  if (
    !record(value) ||
    !keys(value, ["owner", "reason", "inspect"], ["resource"])
  )
    return false;
  if (
    (value.owner !== "human" && value.owner !== "operator") ||
    !text(value.reason)
  )
    return false;
  if (
    !Array.isArray(value.inspect) ||
    value.inspect.length === 0 ||
    !value.inspect.every(
      (item: unknown) =>
        nextStep(item) &&
        (item.kind === "command" || item.kind === "instruction"),
    )
  )
    return false;
  return (
    !("resource" in value) ||
    (record(value.resource) &&
      keys(value.resource, ["kind", "id"]) &&
      text(value.resource.kind) &&
      text(value.resource.id))
  );
}
function validSuperseded(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, "superseded")) return true;
  return sortedStrings(value.superseded) && value.superseded.length > 0;
}
function optionalScalars(value: Record<string, unknown>): boolean {
  if (
    "retryDelayMilliseconds" in value &&
    (!integer(value.retryDelayMilliseconds) || value.retryDelayMilliseconds < 1)
  )
    return false;
  if ("idempotencyKey" in value && !text(value.idempotencyKey)) return false;
  if (
    "attemptedEffect" in value &&
    (value.outcome !== "failed" || !text(value.attemptedEffect))
  )
    return false;
  return validSuperseded(value);
}
function optionalResult(value: Record<string, unknown>): boolean {
  if (!optionalScalars(value)) return false;
  if (
    "bindings" in value &&
    (!record(value.bindings) ||
      !Object.entries(value.bindings).every(
        ([name, entry]) => /^[a-z][A-Za-z0-9]*$/.test(name) && text(entry),
      ))
  )
    return false;
  if ("next" in value && !nextStep(value.next)) return false;
  if ("handoff" in value && !handoff(value.handoff)) return false;
  return "next" in value !== "handoff" in value;
}
function scalarResult(value: Record<string, unknown>): boolean {
  if (
    !text(value.runId) ||
    !text(value.commandIdentity) ||
    !text(value.causeCode)
  )
    return false;
  if (
    value.effectClass !== "inspect" &&
    value.effectClass !== "repository-local" &&
    value.effectClass !== "external"
  )
    return false;
  if (!json(value.data) || !effects(value.effects)) return false;
  if (
    value.outcome === "success"
      ? value.repairAction !== null
      : !text(value.repairAction) || value.data !== null
  )
    return false;
  return causeRow({
    outcome: value.outcome,
    transactionState: value.transactionState,
    failureClass: value.failureClass,
    exitCode: value.exitCode,
    retryable: value.retryable,
    guidance: "next" in value ? "next" : "handoff",
  });
}
export function wireResult(value: unknown): value is WireResult {
  if (
    !record(value) ||
    !keys(
      value,
      [
        "runId",
        "commandIdentity",
        "outcome",
        "effectClass",
        "transactionState",
        "causeCode",
        "failureClass",
        "exitCode",
        "data",
        "retryable",
        "repairAction",
        "effects",
      ],
      [
        "retryDelayMilliseconds",
        "next",
        "handoff",
        "bindings",
        "idempotencyKey",
        "attemptedEffect",
        "superseded",
      ],
    )
  )
    return false;
  return optionalResult(value) && scalarResult(value);
}
function validAttemptedEffect(value: WireResult): boolean {
  return (
    value.attemptedEffect === undefined ||
    [
      ...value.effects.completed,
      ...value.effects.remaining,
      ...value.effects.uncertain,
    ].includes(value.attemptedEffect)
  );
}
function validRetry(value: WireResult): boolean {
  return (
    value.retryable === (value.retryDelayMilliseconds !== undefined) &&
    value.retryable === (value.next?.kind === "retry")
  );
}
export function resultCorrelations(value: WireResult): boolean {
  if (!effectState(value) || !validRetry(value)) return false;
  if (value.next?.kind === "done" && value.outcome !== "success") return false;
  if (value.superseded !== undefined && value.effectClass === "inspect")
    return false;
  return validAttemptedEffect(value);
}
export function typedResult<C extends CauseTable>(
  value: unknown,
  causes: C,
): value is ResultFor<C> {
  if (!wireResult(value) || !resultCorrelations(value)) return false;
  const row = causes[value.causeCode];
  if (!row) return false;
  return (
    value.outcome === row.outcome &&
    value.transactionState === row.transactionState &&
    value.failureClass === row.failureClass &&
    value.exitCode === row.exitCode &&
    value.retryable === row.retryable &&
    (row.guidance === "next"
      ? value.next !== undefined
      : value.handoff !== undefined)
  );
}
export function envelopeShape(value: unknown): value is Envelope {
  if (
    !record(value) ||
    !keys(
      value,
      ["contractVersion", "message", "availablePaths", "result"],
      ["diagnostics"],
    )
  )
    return false;
  return (
    typeof value.contractVersion === "string" &&
    text(value.message) &&
    sortedStrings(value.availablePaths) &&
    wireResult(value.result) &&
    (value.diagnostics === undefined || diagnostics(value.diagnostics))
  );
}
