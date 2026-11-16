import { expect, test } from "bun:test";
import { stateCases } from "./cases.ts";

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

// Independent oracle: identities and counts frozen with the expanded brief,
// before any state add-on source existed. Moving a row between executable
// and pending is a reviewable edit of these numbers, never a silent one.
test("the frozen T3 case table keeps its admitted identities and counts", () => {
  expect(briefFamilies.length).toBe(46);
  const ids = stateCases.map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids)
    expect(id).toMatch(/^[JLKPOHTQSB]\d\d\.[a-z]-[a-z0-9-]+$/);
  const families = new Set(ids.map((id) => id.slice(0, 3)));
  for (const family of briefFamilies) expect(families.has(family)).toBe(true);
  const supporting = [...families].filter(
    (family) => !briefFamilies.includes(family),
  );
  expect(supporting.sort()).toEqual([
    "B01",
    "B02",
    "B03",
    "B04",
    "B05",
    "S01",
    "S02",
    "S03",
    "S04",
  ]);
  expect(stateCases.length).toBe(101);
  const executable = stateCases.filter((row) => row.status === "executable");
  expect(executable.length).toBe(92);
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

// Q01.c (REC-8): every frozen transition maps to at least one case identity,
// and every identity the design names exists in this table.
test("Q01.c-transitions-mapped", async () => {
  const design = await Bun.file(
    new URL(
      "../../../starters/contract3/src/addons/state/DESIGN.md",
      import.meta.url,
    ),
  ).text();
  const rows = design
    .split("\n")
    .filter((line) => /^\| X\d\d \|/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  expect(rows.length).toBe(22);
  const known = new Set(
    stateCases.map((row) => row.id.replace(/^([A-Z]\d\d\.[a-z]).*$/, "$1")),
  );
  for (const row of rows) {
    const cases = (row[4] ?? "").split(",").map((cell) => cell.trim());
    expect(cases.length).toBeGreaterThan(0);
    for (const id of cases) expect(known.has(id)).toBe(true);
  }
  expect(rows.map((row) => row[1])).toEqual(
    Array.from(
      { length: 22 },
      (_, index) => `X${String(index + 1).padStart(2, "0")}`,
    ),
  );
});
