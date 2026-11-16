// The T5 case ledger. Every frozen identity in t5-cases.json is either bound
// to a test in this folder or carries its frozen pending or unproved status
// with a supplier or reason; no test cites an identity that is not frozen.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reportUnproved, unprovedHere, unprovedOn } from "./platform.ts";

const here = import.meta.dir;
type Frozen = {
  readonly id: string;
  readonly status: string;
  readonly supplier?: string;
  readonly note?: string;
};

function frozenCases(): readonly Frozen[] {
  const document: unknown = JSON.parse(
    readFileSync(join(here, "t5-cases.json"), "utf8"),
  );
  const list: unknown =
    typeof document === "object" && document !== null
      ? Reflect.get(document, "cases")
      : undefined;
  if (!Array.isArray(list)) throw new Error("Frozen case file has no cases.");
  return list.map((entry: unknown): Frozen => {
    const read = (key: string): unknown =>
      typeof entry === "object" && entry !== null
        ? Reflect.get(entry, key)
        : undefined;
    const id = read("id");
    const status = read("status");
    const supplier = read("supplier");
    const note = read("note");
    if (typeof id !== "string" || typeof status !== "string")
      throw new Error("Malformed frozen case.");
    return {
      id,
      status,
      ...(typeof supplier === "string" ? { supplier } : {}),
      ...(typeof note === "string" ? { note } : {}),
    };
  });
}

function testSources(): string {
  return readdirSync(here)
    .filter((name) => name.endsWith(".test.ts") && name !== "cases.test.ts")
    .map((name) => readFileSync(join(here, name), "utf8"))
    .join("\n");
}

// Identities cited in test titles and the id table of the umask cases.
function cited(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /["`]((?:D\d\d|R1)\.[a-z0-9-]+(?:\.[0-9]+)*)/g,
  ))
    if (match[1] !== undefined) found.add(match[1]);
  for (const match of source.matchAll(/ and (D\d\d\.[a-z0-9-]+)/g))
    if (match[1] !== undefined) found.add(match[1]);
  return found;
}

test("T5 ledger: the frozen file still has 88 identities over 20 families", () => {
  const cases = frozenCases();
  expect(cases).toHaveLength(88);
  expect(new Set(cases.map((entry) => entry.id.split(".")[0])).size).toBe(20);
});

test("T5 ledger: every planned identity is bound to a test, and no test cites an unknown identity", () => {
  const cases = frozenCases();
  const bound = cited(testSources());
  const planned = cases
    .filter((entry) => entry.status === "planned")
    .map((entry) => entry.id);
  expect(planned.filter((id) => !bound.has(id))).toEqual([]);
  const known = new Set([
    ...cases.map((entry) => entry.id),
    ...repairCaseIds(),
  ]);
  expect([...bound].filter((id) => !known.has(id))).toEqual([]);
});

test("T5 ledger: pending identities name a supplier and unproved ones a reason, and none is bound to a passing test", () => {
  const cases = frozenCases();
  const bound = cited(testSources());
  const open = cases.filter((entry) => entry.status !== "planned");
  expect(open.map((entry) => `${entry.id}:${entry.status}`).sort()).toEqual([
    "D03.target-tree-override:pending",
    "D03.untrusted-ancestor-other-owner:unproved",
    "D13.recovery-report-unchanged:pending",
    "D14.planted-records-no-replay:pending",
    "D18.changing-effects-exclude-maintenance:pending",
  ]);
  for (const entry of open) {
    expect(
      entry.status === "pending" ? entry.supplier : entry.note,
    ).toBeString();
    expect(bound.has(entry.id)).toBe(false);
  }
});

function repairCaseIds(): readonly string[] {
  const document: unknown = JSON.parse(
    readFileSync(join(here, "t5-repair-1-cases.json"), "utf8"),
  );
  const list: unknown =
    typeof document === "object" && document !== null
      ? Reflect.get(document, "cases")
      : undefined;
  if (!Array.isArray(list)) throw new Error("Repair case file has no cases.");
  return list.map((entry: unknown) => {
    const id: unknown =
      typeof entry === "object" && entry !== null
        ? Reflect.get(entry, "id")
        : undefined;
    if (typeof id !== "string") throw new Error("Malformed repair case.");
    return id;
  });
}

test("T5 ledger: every repair round 1 control is bound to a test", () => {
  const ids = repairCaseIds();
  expect(ids).toHaveLength(7);
  const bound = cited(
    testSources() + readFileSync(join(here, "cases.test.ts"), "utf8"),
  );
  expect(ids.filter((id) => !bound.has(id))).toEqual([]);
});

// Rows the ticket wants as process rows but observed only in process-free
// component tests, and the half of D15 nothing in this unit can prove.
const processRowUnproved = {
  "D17.no-change-after-freeze":
    "the process exits at drain, so post-freeze activity cannot be observed there; component evidence only",
  "D15 public-output redaction point":
    "no owner in the kernel or host (open with Nathan); only the sink point is proved",
} as const;
const processRowObservedByRepair = {
  "D10.late-completion-ignored": "R1.late-completion-process",
} as const;

test("R1.platform-outcomes-pinned: nothing is skipped, and every platform-bound or unproved row is pinned and reported", () => {
  const sources = testSources();
  expect(sources).not.toMatch(
    /\btest\.(skip|skipIf|todo|only|if|failing)\b|\bdescribe\.(skip|skipIf|todo|only|if)\b/,
  );
  expect(unprovedOn("darwin")).toEqual([]);
  expect(unprovedOn("linux")).toEqual(["D09.no-space-volume"]);
  const here = unprovedOn(process.platform);
  expect(here.length).toBe(process.platform === "darwin" ? 0 : 1);
  for (const id of here) {
    const reason = unprovedHere(id);
    expect(reason).toBeString();
    reportUnproved(id, reason ?? "");
  }
  for (const [row, reason] of Object.entries(processRowUnproved))
    reportUnproved(row, reason);
  expect(Object.keys(processRowObservedByRepair)).toEqual([
    "D10.late-completion-ignored",
  ]);
  expect(repairCaseIds()).toContain(
    processRowObservedByRepair["D10.late-completion-ignored"],
  );
});
