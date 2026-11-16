import { expect, test } from "bun:test";
import { envelopeShape } from "../../../starters/contract3/src/kernel/validation/result.ts";
import { envelope } from "./envelope-fixture.ts";

// Swarm-triage kernel-internal findings (K2-6, K2-12). Their oracle is the
// coding standard and the predicate's own declared type, not a frozen case.

test("K2-6: envelopeShape, typed `value is Envelope`, checks diagnostics", () => {
  // Diagnostics written from the DIAG available shape, not kernel output.
  const available = {
    status: "available",
    file: null,
    sinkFailure: null,
    droppedRecords: 0,
    unflushedRecords: 0,
    truncatedRecords: 0,
    countsComplete: true,
    closed: true,
  };
  expect(envelopeShape(envelope(null))).toBe(true);
  expect(envelopeShape({ ...envelope(null), diagnostics: available })).toBe(
    true,
  );
  for (const diagnostics of [
    "not a diagnostics object",
    { ...available, status: "invented" },
    { ...available, droppedRecords: -1 },
  ])
    expect(envelopeShape({ ...envelope(null), diagnostics })).toBe(false);
});
