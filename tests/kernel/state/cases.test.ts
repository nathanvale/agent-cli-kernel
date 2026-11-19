import { expect, test } from "bun:test";
import { stateCases } from "./cases.ts";
import { caseTest } from "./harness.ts";

const briefFamilies = [
  ...["J01", "J02", "J03", "J04", "J05", "J06", "J07"],
  ...["L01", "L02", "L03", "L04", "L05", "L06"],
  ...["K01", "K02", "K03", "K04", "K05", "K06", "K07", "K08", "K09"],
  ...["P01", "P02", "P03", "P04", "P05", "P06"],
  ...["O01", "O02", "O03", "O04", "O05", "O06", "O07", "O08", "O09", "O10"],
  ...["H01", "H02", "H03"],
  ...["T01", "T02", "T03", "T04"],
  "Q01",
];
const journalVersionTwoFamilies = ["J08", "L07", "L08", "K10", "K11"];

test("the frozen T3 case table keeps its admitted identities and counts", () => {
  expect(briefFamilies.length).toBe(46);
  const ids = stateCases.map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids)
    expect(id).toMatch(/^[JLKPOHTQSBC]\d\d\.[a-z]-[a-z0-9-]+$/);
  const families = new Set(ids.map((id) => id.slice(0, 3)));
  const knownFamilies = [...briefFamilies, ...journalVersionTwoFamilies];
  for (const family of knownFamilies) expect(families.has(family)).toBe(true);
  const supporting = [...families].filter(
    (family) => !knownFamilies.includes(family),
  );
  expect(supporting.sort()).toEqual([
    "B01",
    "B02",
    "B03",
    "B04",
    "B05",
    "B06",
    "C01",
    "S01",
    "S02",
    "S03",
    "S04",
    "S05",
  ]);
  expect(stateCases.length).toBe(138);
  const executable = stateCases.filter((row) => row.status === "executable");
  expect(executable.length).toBe(129);
  for (const row of executable)
    if (row.status === "executable")
      expect(["coordination", "any"]).toContain(row.platform);
  expect(
    executable
      .filter((row) => row.status === "executable" && row.nonRoot === true)
      .map((row) => row.id)
      .sort(),
  ).toEqual([
    "K06.h-unreadable-case-unavailable",
    "L04.a-corrupt-journal-refuses",
    "L07.b-admission-does-not-read-settled",
    "L07.g-failed-move-keeps-outcome",
    "S03.a-store-failure-preserves-item",
  ]);
  const pending = stateCases.filter((row) => row.status === "pending");
  expect(pending.map((row) => row.id).sort()).toEqual([
    "H01.a-attestation-satisfies-stop-only",
    "H03.a-attestation-race-and-crash",
    "J07.a-diagnostics-removed",
    "K04.b-unknown-closure-with-fixture-authority",
    "K05.b-actual-credential-nonforgeability",
    "K08.c-surviving-delegate-process",
    "O06.a-delegated-writer",
    "O07.b-reclaim-race",
    "O08.a-takeover-crash-points",
  ]);
  for (const row of pending)
    if (row.status === "pending") expect(row.reason.length).toBeGreaterThan(0);
  for (const row of stateCases) {
    expect(row.sources.length).toBeGreaterThan(0);
    expect(row.observation.length).toBeGreaterThan(0);
    expect(row.red.length).toBeGreaterThan(0);
  }
});

const transitionDesigns = ["DESIGN.md", "DESIGN-V2-TRANSITIONS.md"];
const casesAwaitingLaterSlices: Readonly<Record<string, readonly string[]>> = {
  X27: ["Q02.a", "Q02.b", "Q02.c", "Q02.d"],
  X28: ["K11.a"],
  X29: ["K11.c", "K11.d"],
  X30: ["Q02.e"],
};

async function transitionRows(name: string): Promise<string[][]> {
  const design = await Bun.file(
    new URL(`../../../kernel/src/addons/state/${name}`, import.meta.url),
  ).text();
  return design
    .split("\n")
    .filter((line) => /^\| X\d\d \|/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
}

caseTest("Q01.c-transitions-mapped", async () => {
  const [versionOne, versionTwo] = await Promise.all(
    transitionDesigns.map(transitionRows),
  );
  expect(versionOne?.length).toBe(22);
  expect(versionTwo?.length).toBe(8);
  const rows = [...(versionOne ?? []), ...(versionTwo ?? [])];
  const known = new Set(
    stateCases.map((row) => row.id.replace(/^([A-Z]\d\d\.[a-z]).*$/, "$1")),
  );
  for (const row of rows) {
    const cases = (row[4] ?? "").split(",").map((cell) => cell.trim());
    expect(cases.length).toBeGreaterThan(0);
    for (const id of cases) expect(id).toMatch(/^[A-Z]\d\d\.[a-z]$/);
    expect(cases.filter((id) => !known.has(id))).toEqual([
      ...(casesAwaitingLaterSlices[row[1] ?? ""] ?? []),
    ]);
  }
  expect(rows.map((row) => row[1])).toEqual(
    Array.from(
      { length: 30 },
      (_, index) => `X${String(index + 1).padStart(2, "0")}`,
    ),
  );
});

test("every executable case is registered once and no pending case is claimed", async () => {
  const files = [
    "cases.test.ts",
    "journal.test.ts",
    "recovery.test.ts",
    "coordination.test.ts",
    "transient.test.ts",
    "component.test.ts",
    "seams.test.ts",
    "route.test.ts",
  ];
  const sources = await Promise.all(
    files.map((name) => Bun.file(new URL(name, import.meta.url)).text()),
  );
  const registered = sources.flatMap((source) =>
    [...source.matchAll(/caseTest\(\s*"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    ),
  );
  const executable = stateCases
    .filter((row) => row.status === "executable")
    .map((row) => row.id)
    .sort();
  expect([...registered].sort()).toEqual(executable);
  expect(new Set(registered).size).toBe(registered.length);
});
