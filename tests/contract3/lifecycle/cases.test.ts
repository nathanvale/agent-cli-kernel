// The frozen T2 slice A case set is exercised exactly once, and every case
// outside slice A names its supplier or its reviewed unreachable rationale.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { record } from "../../../starters/contract3/src/kernel/validation/primitives.ts";
import { familiesByFile, sliceCases } from "./coverage.ts";
import { allCases } from "./harness.ts";

test("every frozen slice A case is bound to exactly one process test file", () => {
  const ids = allCases.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  const covered = [
    ...sliceCases("writer"),
    ...sliceCases("lifecycle"),
    ...sliceCases("programs"),
  ].map((entry) => entry.id);
  const slice = allCases
    .filter((entry) => entry.status === "slice-a")
    .map((entry) => entry.id);
  expect(new Set(covered).size).toBe(covered.length);
  expect([...covered].sort()).toEqual([...slice].sort());
  expect(slice.length).toBe(122);
  const families: readonly string[] = Object.values(familiesByFile).flat();
  for (const entry of allCases.filter((item) => item.status === "slice-a")) {
    expect(families).toContain(entry.family);
  }
});

test("pending and unreachable cases keep their supplier or rationale", () => {
  const pending = allCases.filter((entry) => entry.status === "pending");
  const unreachable = allCases.filter(
    (entry) => entry.status === "unreachable",
  );
  expect(pending.map((entry) => entry.id).sort()).toEqual([
    "F02.diagnostics-in-fallback",
    "L06.excluded-termination",
    "L12.hostile-diagnostic-paths",
    "P01.valid-in-effect-start",
    "P02.retained-handle-after-closure",
    "P03.wrong-run-or-effect-handle",
    "P04.closure-start-race",
    "P05.domain-program-isolation",
    "R01.reader-no-replay",
    "W06.diagnostics-fault-no-fallback",
  ]);
  for (const entry of pending) expect(entry.supplier?.trim()).toBeTruthy();
  expect(unreachable.map((entry) => entry.id)).toEqual([
    "F04.fallback-encoding-fails",
  ]);
  for (const entry of unreachable) expect(entry.note?.trim()).toBeTruthy();
});

// Findings round: each supporting identity in findings-cases.json names its
// home file, and that file carries the identity (S03 is an observation note).
test("every findings-round case identity is exercised in its home file", () => {
  const listed: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "findings-cases.json"), "utf8"),
  );
  const cases =
    record(listed) && Array.isArray(listed.cases) ? listed.cases : [];
  expect(cases.length).toBe(11);
  for (const entry of cases) {
    const id = record(entry) ? entry.id : undefined;
    const home = record(entry) ? entry.home : undefined;
    if (typeof id !== "string" || typeof home !== "string")
      throw new Error("Malformed findings-round case.");
    const source = readFileSync(join(import.meta.dir, "..", home), "utf8");
    expect(source.includes(`"${id}`) || source.includes(`\`${id}`)).toBe(true);
  }
});
