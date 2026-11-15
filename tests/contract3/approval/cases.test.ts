import { expect, test } from "bun:test";
import { approvalCases } from "./cases.ts";
import type { ApprovalCase } from "./cases.ts";

// Independent oracle: counts frozen with the expanded brief, not derived
// from implementation. Downgrading a row to pending is a reviewable edit.
test("the frozen T4 case table keeps its admitted identities and counts", () => {
  const rows: readonly ApprovalCase[] = approvalCases;
  const families = new Set(rows.map((row) => row.id.slice(0, 3)));
  expect(families.size).toBe(25);
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  expect(rows.length).toBe(94);
  expect(rows.filter((row) => row.status === "executable").length).toBe(77);
  const pending = rows.filter((row) => row.status === "pending");
  expect(pending.length).toBe(17);
  for (const row of pending) expect(row.reason.length).toBeGreaterThan(0);
});
