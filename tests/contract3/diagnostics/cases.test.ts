// The T5 case ledger. Every frozen identity in t5-cases.json is either bound
// to a test in this folder or carries its frozen pending or unproved status
// with a supplier or reason; no test cites an identity that is not frozen.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  for (const match of source.matchAll(/["`](D\d\d\.[a-z0-9-]+(?:\.[0-9]+)*)/g))
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
  const known = new Set(cases.map((entry) => entry.id));
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
