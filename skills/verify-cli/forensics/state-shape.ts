import { plainRecord, textField } from "./io.ts";

const validEventKinds = new Set([
  "effect-started",
  "delegate-admitted",
  "effect-confirmed",
  "effect-unconfirmed",
  "completion",
  "not-applied",
  "outcome",
  "emergency",
]);
const effectEventKinds = new Set([
  "effect-started",
  "delegate-admitted",
  "effect-confirmed",
  "effect-unconfirmed",
]);
const validDispositions = new Set([
  "completed",
  "not-applied",
  "outcome-unknown",
]);

function exactStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const item = textField(entry);
    if (item === null) return undefined;
    out.push(item);
  }
  return out;
}

function sortedUniqueStrings(value: readonly string[]): boolean {
  return value.every(
    (entry, index) => index === 0 || (value[index - 1] ?? "") < entry,
  );
}

function validScopeResource(entry: unknown): boolean {
  const item = plainRecord(entry);
  if (
    !item ||
    textField(item.resource) === null ||
    exactStringList(item.keys) === undefined
  )
    return false;
  const hasPath = textField(item.path) !== null;
  const hasKey = textField(item.key) !== null;
  return hasPath !== hasKey;
}

function validScopePayload(value: unknown): boolean {
  const scope = plainRecord(value);
  if (
    !scope ||
    typeof scope.unknown !== "boolean" ||
    exactStringList(scope.keys) === undefined ||
    exactStringList(scope.invariants) === undefined ||
    !Array.isArray(scope.resources)
  )
    return false;
  return scope.resources.every(validScopeResource);
}

function validRevisionsPayload(value: unknown): boolean {
  const revisions = plainRecord(value);
  return (
    revisions !== undefined &&
    Object.values(revisions).every((entry) => textField(entry) !== null)
  );
}

function validApprovalField(value: unknown): boolean {
  if (value === null) return true;
  const approval = plainRecord(value);
  return approval?.kind === "preview" && textField(approval.reference) !== null;
}

function validOwnerField(value: unknown): boolean {
  const owner = plainRecord(value);
  return (
    owner?.lease === "owner.lease" &&
    typeof owner.pid === "number" &&
    typeof owner.startedAt === "number"
  );
}

function hasTextFields(
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => textField(payload[key]) !== null);
}

export function validIntentPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
  operationId: string,
): boolean {
  if (!payload || payload.operationId !== operationId) return false;
  const effects = exactStringList(payload.effects);
  if (
    !hasTextFields(payload, ["commandIdentity", "runId"]) ||
    effects === undefined ||
    effects.length === 0 ||
    !sortedUniqueStrings(effects)
  )
    return false;
  return (
    validScopePayload(payload.scope) &&
    validRevisionsPayload(payload.revisions) &&
    validOwnerField(payload.owner) &&
    exactStringList(payload.coordination) !== undefined &&
    validApprovalField(payload.approval) &&
    (payload.closes === null || textField(payload.closes) !== null)
  );
}

function validClosureEvidence(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry: unknown) => {
    const item = plainRecord(entry);
    return item !== undefined && hasTextFields(item, ["effect", "observation"]);
  });
}

export function validClosurePayload(
  payload: Readonly<Record<string, unknown>> | undefined,
  operationId: string,
): boolean {
  if (!payload || payload.operationId !== operationId) return false;
  const disposition = textField(payload.disposition);
  return (
    disposition !== null &&
    validDispositions.has(disposition) &&
    hasTextFields(payload, [
      "closureId",
      "reason",
      "journalRevision",
      "qualification",
      "recoveryRunId",
    ]) &&
    validClosureEvidence(payload.evidence)
  );
}

export function invalidEventReason(
  records: readonly {
    readonly kind: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[],
  declaredEffects: readonly string[] | undefined,
): string | undefined {
  for (const record of records) {
    if (!validEventKinds.has(record.kind))
      return `events file contains unknown event kind ${record.kind}`;
    if (effectEventKinds.has(record.kind)) {
      const effect = textField(record.payload.effect);
      if (
        effect === null ||
        (declaredEffects !== undefined && !declaredEffects.includes(effect))
      )
        return `events file contains undeclared or invalid effect on ${record.kind}`;
    }
  }
  return undefined;
}
