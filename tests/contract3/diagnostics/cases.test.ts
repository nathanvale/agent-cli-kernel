import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportUnproved, unprovedHere, unprovedOn } from "./platform.ts";

const here = import.meta.dir;
type Frozen = {
  readonly id: string;
  readonly status: string;
  readonly supplier?: string | undefined;
  readonly note?: string | undefined;
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
      supplier: typeof supplier === "string" ? supplier : undefined,
      note: typeof note === "string" ? note : undefined,
    };
  });
}

function testSources(): string {
  return readdirSync(here)
    .filter((name) => name.endsWith(".test.ts") && name !== "cases.test.ts")
    .map((name) => readFileSync(join(here, name), "utf8"))
    .join("\n");
}

function cited(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /["`]((?:D\d\d|R1|R2)\.[a-z0-9-]+(?:\.[0-9]+)*)/g,
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
    ...repairCaseIds(2),
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

function repairCaseIds(round: 1 | 2 = 1): readonly string[] {
  const document: unknown = JSON.parse(
    readFileSync(join(here, `t5-repair-${round}-cases.json`), "utf8"),
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

test("T5 ledger: every repair control is bound to a test", () => {
  const ids = [...repairCaseIds(1), ...repairCaseIds(2)];
  expect(ids).toHaveLength(16);
  const bound = cited(
    testSources() + readFileSync(join(here, "cases.test.ts"), "utf8"),
  );
  expect(ids.filter((id) => !bound.has(id))).toEqual([]);
});

const processRowUnproved = {
  "D17.no-change-after-freeze":
    "the process exits at drain, so post-freeze activity cannot be observed there; component evidence only",
} as const;
const notApplicableHere = {
  "D15 public-output redaction point":
    "the host owns public-output redaction (accepted decision, contract question 2 of 8); proved at T8, not by this add-on",
} as const;
const processRowObservedByRepair = {
  "D10.late-completion-ignored": "R2.late-completion-observed",
} as const;

test("R1.platform-outcomes-pinned: nothing is skipped, and every platform-bound or unproved row is pinned and reported", () => {
  const sources = testSources();
  expect(sources).not.toMatch(
    /\b(?:test|it|describe)\.(?:skip|skipIf|todo|only|if|failing|todoIf)\b|\bx(?:it|test|describe)\(/,
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
  expect(Object.keys(notApplicableHere)).toEqual([
    "D15 public-output redaction point",
  ]);
  for (const [row, reason] of Object.entries(notApplicableHere))
    process.stderr.write(`NOT APPLICABLE ${row}: ${reason}\n`);
  expect(Object.keys(processRowObservedByRepair)).toEqual([
    "D10.late-completion-ignored",
  ]);
  expect(repairCaseIds(2)).toContain(
    processRowObservedByRepair["D10.late-completion-ignored"],
  );
});

type Executed = { readonly name: string; readonly skipped: boolean };

function executedTests(): {
  readonly exit: number | null;
  readonly tests: readonly Executed[];
} {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "t5-ledger-"));
  try {
    const report = join(scratch, "junit.xml");
    const files = readdirSync(here)
      .filter((name) => name.endsWith(".test.ts") && name !== "cases.test.ts")
      .map((name) => join(here, name));
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        "--timeout",
        "120000",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        ...files,
      ],
      cwd: join(here, "../../.."),
      stdout: "ignore",
      stderr: "ignore",
    });
    const xml = readFileSync(report, "utf8");
    const tests = [
      ...xml.matchAll(
        /<testcase name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g,
      ),
    ].map(
      (match): Executed => ({
        name: (match[1] ?? "")
          .replaceAll("&quot;", '"')
          .replaceAll("&amp;", "&")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">"),
        skipped: (match[3] ?? "").includes("<skipped"),
      }),
    );
    return { exit: child.exitCode, tests };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function idsIn(name: string): readonly string[] {
  return [...name.matchAll(/(?:D\d\d|R1|R2)\.[a-z0-9-]+(?:\.[0-9]+)*/g)].map(
    (match) => match[0],
  );
}

test("R2.ledger-binds-executed: every planned row and repair control ran and passed on this host; nothing was skipped", () => {
  const { exit, tests } = executedTests();
  expect(exit).toBe(0);
  expect(tests.length).toBeGreaterThan(0);
  expect(
    tests.filter((entry) => entry.skipped).map((entry) => entry.name),
  ).toEqual([]);
  const platformBound = (entry: Executed) => / UNPROVED on /.test(entry.name);
  const proved = new Set(
    tests
      .filter((entry) => !platformBound(entry))
      .flatMap((entry) => idsIn(entry.name)),
  );
  const unproved = new Set(
    tests.filter(platformBound).flatMap((entry) => idsIn(entry.name)),
  );
  const unprovedHereIds = unprovedOn(process.platform);
  const planned = frozenCases()
    .filter((entry) => entry.status === "planned")
    .map((entry) => entry.id);
  expect(
    planned.filter((id) => !unprovedHereIds.includes(id) && !proved.has(id)),
  ).toEqual([]);
  expect(unprovedHereIds.filter((id) => !unproved.has(id))).toEqual([]);
  const ledgerOwn = ["R1.platform-outcomes-pinned", "R2.ledger-binds-executed"];
  const repairs = [...repairCaseIds(1), ...repairCaseIds(2)].filter(
    (id) => !ledgerOwn.includes(id),
  );
  expect(repairs.filter((id) => !proved.has(id))).toEqual([]);
}, 600_000);
