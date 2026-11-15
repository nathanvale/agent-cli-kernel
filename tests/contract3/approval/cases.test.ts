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

// Every executable row is named by a test that checks it against
// expectedFor(); a pending row is never named as executed.
test("every executable case is exercised and no pending case is claimed", async () => {
  const sources = await Promise.all(
    ["component.test.ts", "process.test.ts"].map((name) =>
      Bun.file(new URL(name, import.meta.url)).text(),
    ),
  );
  const named = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/"[^"\n]*"/g)].flatMap((literal) =>
        [...literal[0].matchAll(/\b[ACS]\d\d\.[a-z]-[a-z0-9-]+/g)].map(
          (match) => match[0],
        ),
      ),
    ),
  );
  const executable = approvalCases
    .filter((row) => row.status === "executable")
    .map((row) => row.id)
    .sort();
  expect([...named].sort()).toEqual(executable);
  for (const source of sources) expect(source).toContain("expectedFor(");
});
