import { appendFileSync } from "node:fs";
import { expect } from "bun:test";
import { fallbackMessage } from "../../../starters/contract3/src/kernel/fallback.ts";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import {
  containerDepth,
  envelopeOf,
  expectedRow,
  n,
  resultOf,
  text,
} from "./harness.ts";
import type { Case, Observed } from "./harness.ts";

// 3.0.0 key sets and step kinds, authored from wire.md and next-steps.md.
const envelopeKeys = [
  "contractVersion",
  "message",
  "availablePaths",
  "result",
  "diagnostics",
];
const resultKeys = [
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
  "retryDelayMilliseconds",
  "repairAction",
  "effects",
  "next",
  "handoff",
  "bindings",
  "idempotencyKey",
  "attemptedEffect",
];
const effectKeys = ["completed", "remaining", "uncertain", "inventoryComplete"];
const handoffKeys = ["owner", "reason", "inspect", "resource"];
const stepKinds = ["command", "instruction", "retry", "done"];
const marker = "FX-REJECTED-PAYLOAD";

// Raw receipts go to the evidence owner when T2_EVIDENCE names a file.
export function receipt(entry: Case, observed: Observed, extra: object = {}) {
  const path = process.env.T2_EVIDENCE;
  if (!path) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      id: entry.id,
      argv: entry.argv.map((arg) =>
        arg.length > 120 ? `${arg.slice(0, 40)}...(${arg.length} chars)` : arg,
      ),
      scenario: entry.scenario ?? null,
      stdin: entry.stdin,
      exit: observed.code,
      signal: observed.signal,
      stdoutBytes: observed.stdout.byteLength,
      stdoutHead: text(observed.stdout.subarray(0, 600)),
      stderr: text(observed.stderr),
      elapsedMilliseconds: Math.round(observed.exitedAt - observed.spawnedAt),
      ledger: observed.ledger,
      ...extra,
    })}\n`,
  );
}

function keysWithin(value: unknown, allowed: readonly string[]) {
  expect(record(value)).toBe(true);
  if (record(value))
    expect(Object.keys(value).filter((key) => !allowed.includes(key))).toEqual(
      [],
    );
}

function steps(result: Record<string, unknown>): unknown[] {
  const handoff = result.handoff;
  if (record(handoff) && Array.isArray(handoff.inspect)) return handoff.inspect;
  return result.next === undefined ? [] : [result.next];
}

function assertFallback(
  entry: Case,
  observed: Observed,
  envelope: Record<string, unknown>,
) {
  const result = resultOf(envelope);
  const raw = text(observed.stdout);
  expect(envelope.contractVersion).toBe("3.0.0");
  expect(envelope.message).toBe(fallbackMessage);
  expect(result.data).toBeNull();
  expect(result.retryable).toBe(false);
  expect(raw.includes(marker)).toBe(false);
  expect(observed.stdout.byteLength).toBeLessThanOrEqual(16_384);
  expect(containerDepth(envelope)).toBeLessThanOrEqual(8);
  keysWithin(envelope, envelopeKeys);
  keysWithin(result, resultKeys);
  keysWithin(result.effects, effectKeys);
  if (result.handoff !== undefined) keysWithin(result.handoff, handoffKeys);
  for (const step of steps(result))
    expect(stepKinds).toContain(
      record(step) && typeof step.kind === "string" ? step.kind : "",
    );
  const inspect = entry.expect.inspectCommand;
  if (typeof inspect === "string")
    expect(steps(result)).toContainEqual({
      kind: "command",
      command: inspect,
      args: [],
    });
}

// One validated envelope at the independently expected station.
export function assertEnvelope(entry: Case, observed: Observed) {
  const expected = entry.expect;
  const causeCode = expected.causeCode;
  if (typeof causeCode !== "string")
    throw new Error(`${entry.id} has no cause.`);
  const row = expectedRow(causeCode);
  expect(observed.stderr.byteLength).toBe(0);
  const envelope = envelopeOf(observed.stdout);
  const result = resultOf(envelope);
  const arm =
    result.handoff !== undefined && result.next === undefined
      ? "H"
      : result.next !== undefined && result.handoff === undefined
        ? record(result.next) && result.next.kind === "retry"
          ? "N:retry"
          : "N"
        : "invalid";
  expect({
    causeCode: result.causeCode,
    outcome: result.outcome,
    transactionState: result.transactionState,
    failureClass: result.failureClass,
    exitCode: result.exitCode,
    retryable: result.retryable,
    arm,
  }).toEqual({
    causeCode,
    outcome: row.outcome,
    transactionState: row.transactionState,
    failureClass: row.failureClass,
    exitCode: row.exitCode,
    retryable: row.retryable,
    arm: row.guidance,
  });
  if (expected.identityPending !== true)
    expect(result.commandIdentity).toBe(expected.commandIdentity);
  const realExit =
    typeof expected.exit === "number" ? expected.exit : row.exitCode;
  expect(observed.signal).toBeNull();
  expect(observed.code).toBe(realExit);
  if (expected.signal === undefined)
    expect(observed.code).toBe(n(result.exitCode));
  if (expected.effects !== undefined)
    expect(result.effects).toEqual(expected.effects);
  if (typeof expected.minimumBytes === "number")
    expect(observed.stdout.byteLength).toBeGreaterThanOrEqual(
      expected.minimumBytes,
    );
  if (expected.fallback === true) assertFallback(entry, observed, envelope);
  return { envelope, result };
}

export function assertHuman(entry: Case, observed: Observed) {
  const expected = entry.expect;
  expect(observed.signal).toBeNull();
  expect(observed.code).toBe(n(expected.exit));
  const out = text(observed.stdout);
  const err = text(observed.stderr);
  if (expected.stdout === "empty") expect(out).toBe("");
  if (expected.stdout === "text") {
    expect(out.length).toBeGreaterThan(0);
    expect(out.trimStart().startsWith("{")).toBe(false);
  }
  if (expected.stderr === "empty") expect(err).toBe("");
  if (expected.stderr === "line") {
    expect(err.endsWith("\n")).toBe(true);
    expect(err.indexOf("\n")).toBe(err.length - 1);
    expect(err.trim().length).toBeGreaterThan(0);
  }
}
