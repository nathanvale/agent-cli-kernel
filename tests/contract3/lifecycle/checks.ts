import { appendFileSync } from "node:fs";
import { expect } from "bun:test";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import {
  deepestLevel,
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
// Independent oracle: the fallback's fixed bounded message, restated here from
// the frozen T2 binding (component-handoff-a). A changed literal must fail
// this test rather than move the expectation with it.
const independentFallbackMessage =
  "The result could not be delivered safely. Follow the guidance and inspect effects independently before any new run.";

// Independent oracle: the binding default words (B3).
export const authorityDefaults = {
  guidance: {
    handoff: {
      owner: "human",
      reason:
        "This command needs an exact-item grant from its authority owner before it can run.",
      inspect: [
        {
          kind: "instruction",
          text: "Authority owner: review the requested item and decide whether to grant it.",
        },
      ],
    },
  },
  repairAction:
    "Obtain an exact-item grant from the command's authority owner, then decide on a new run.",
} as const;

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
  expect(envelope.message).toBe(independentFallbackMessage);
  expect(result.data).toBeNull();
  expect(result.retryable).toBe(false);
  expect(raw.includes(marker)).toBe(false);
  expect(observed.stdout.byteLength).toBeLessThanOrEqual(16_384);
  // B2.05: deepest value level, envelope at level 0, at most 8 (LIFE-9).
  expect(deepestLevel(envelope)).toBeLessThanOrEqual(8);
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

// The guidance arm a printed result carries: N, N:retry, H or invalid.
function armOf(result: Record<string, unknown>): string {
  const hasNext = result.next !== undefined;
  const hasHandoff = result.handoff !== undefined;
  if (hasNext === hasHandoff) return "invalid";
  if (hasHandoff) return "H";
  return record(result.next) && result.next.kind === "retry" ? "N:retry" : "N";
}

function assertStation(result: Record<string, unknown>, causeCode: string) {
  const row = expectedRow(causeCode);
  expect({
    causeCode: result.causeCode,
    outcome: result.outcome,
    transactionState: result.transactionState,
    failureClass: result.failureClass,
    exitCode: result.exitCode,
    retryable: result.retryable,
    arm: armOf(result),
  }).toEqual({
    causeCode,
    outcome: row.outcome,
    transactionState: row.transactionState,
    failureClass: row.failureClass,
    exitCode: row.exitCode,
    retryable: row.retryable,
    arm: row.guidance,
  });
  return row;
}

function assertExit(
  expected: Case["expect"],
  observed: Observed,
  result: Record<string, unknown>,
  rowExit: number,
) {
  expect(observed.signal).toBeNull();
  expect(observed.code).toBe(
    expected.exit === undefined ? rowExit : n(expected.exit),
  );
  if (expected.signal === undefined)
    expect(observed.code).toBe(n(result.exitCode));
}

// One validated envelope at the independently expected station.
export function assertEnvelope(entry: Case, observed: Observed) {
  const expected = entry.expect;
  const causeCode = expected.causeCode;
  if (typeof causeCode !== "string")
    throw new Error(`${entry.id} has no cause.`);
  expect(observed.stderr.byteLength).toBe(0);
  const envelope = envelopeOf(observed.stdout);
  const result = resultOf(envelope);
  const row = assertStation(result, causeCode);
  if (expected.identityPending !== true)
    expect(result.commandIdentity).toBe(expected.commandIdentity);
  assertExit(expected, observed, result, row.exitCode);
  if (expected.effects !== undefined)
    expect(result.effects).toEqual(expected.effects);
  if (expected.minimumBytes !== undefined)
    expect(observed.stdout.byteLength).toBeGreaterThanOrEqual(
      n(expected.minimumBytes),
    );
  if (expected.fallback === true) assertFallback(entry, observed, envelope);
  return { envelope, result };
}

// N14: what each human navigation page must show, authored from DISC-1,
// DISC-3, DISC-5 and DISC-6 and the fixture's declared routes.
const humanContent: Readonly<Record<string, readonly string[]>> = {
  "W02.help-stdout": [
    "Usage:",
    "read",
    "refuse",
    "--json",
    "--help",
    "--discover",
    "--discover-command",
  ],
  "W02.discover-stdout": [
    "3.0.0",
    "fx.read",
    "fx.help",
    "fx.discovery",
    "fx.command-discovery",
    "fx.dispatch",
  ],
  "W02.discover-command-stdout": ["fx.read", "read", "SUCCESS_UNCHANGED"],
};

function assertHumanText(entry: Case, out: string) {
  const words = humanContent[entry.id];
  if (!words) throw new Error(`${entry.id} has no human content oracle.`);
  expect(out.trimStart().startsWith("{")).toBe(false);
  for (const word of words) expect(out).toContain(word);
}

function assertLine(err: string) {
  expect(err.endsWith("\n")).toBe(true);
  expect(err.indexOf("\n")).toBe(err.length - 1);
  expect(err.trim().length).toBeGreaterThan(0);
}

export function assertHuman(entry: Case, observed: Observed) {
  const expected = entry.expect;
  expect(observed.signal).toBeNull();
  expect(observed.code).toBe(n(expected.exit));
  const out = text(observed.stdout);
  const err = text(observed.stderr);
  if (expected.stdout === "empty") expect(out).toBe("");
  if (expected.stdout === "text") assertHumanText(entry, out);
  if (expected.stderr === "empty") expect(err).toBe("");
  if (expected.stderr === "line") assertLine(err);
}
