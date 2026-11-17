import { expect, test } from "bun:test";
import { familyCases, frozenInputs, repairCases } from "./cases.ts";

test("frozen repair identities are unique and cover R01 to R18 except K1", () => {
  const ids = repairCases.map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...new Set(repairCases.map((item) => item.family))].sort()).toEqual(
    [
      "R01",
      "R02",
      "R03",
      "R04",
      "R05",
      "R06",
      "R07",
      "R08",
      "R09",
      "R10",
      "R11",
      "R12",
      "R13",
      "R14",
      "R15",
      "R16",
      "R17",
      "R18",
    ].sort(),
  );
  expect(Object.isFrozen(repairCases)).toBe(true);
  expect(repairCases.every((item) => Object.isFrozen(item))).toBe(true);
});

test("frozen repair counts per family", () => {
  const count = (family: string, status: "active" | "pending") =>
    repairCases.filter(
      (item) => item.family === family && item.status === status,
    ).length;
  expect(
    Object.fromEntries(
      [
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07",
        "R08",
        "R09",
        "R10",
        "R11",
        "R12",
        "R13",
        "R14",
        "R15",
        "R16",
        "R17",
        "R18",
      ].map((family) => [
        family,
        [count(family, "active"), count(family, "pending")],
      ]),
    ),
  ).toEqual({
    R01: [7, 1],
    R02: [8, 0],
    R03: [6, 0],
    R04: [5, 0],
    R05: [4, 0],
    R06: [3, 0],
    R07: [6, 0],
    R08: [4, 1],
    R09: [6, 0],
    R10: [6, 0],
    R11: [5, 1],
    R12: [6, 0],
    R13: [4, 0],
    R14: [6, 0],
    R15: [5, 0],
    R16: [0, 1],
    R17: [3, 0],
    R18: [147, 2],
  });
});

test("every pending case names its supplier", () => {
  expect(
    repairCases
      .filter((item) => item.status === "pending")
      .map((item) => [item.id, item.supplier]),
  ).toEqual([
    ["R01.concurrent-real-state", "T3"],
    ["R08.first-signal-during-validation", "T2"],
    ["R11.rendered-host-rule", "T7"],
    ["R16.authority-denial-owner", "T2"],
    ["R18.agreement-after-render", "T2"],
    ["R18.u2.emission-fallback", "T2"],
  ]);
});

test("frozen inputs named by the expectations", () => {
  expect(frozenInputs.reservedCauses).toEqual([
    "INTERNAL_PREPARATION",
    "INTERNAL_RESULT_UNCHANGED",
    "INTERNAL_RESULT_COMPLETED",
    "INTERNAL_RESULT_PARTIAL",
    "INTERNAL_RESULT_UNKNOWN",
  ]);
  expect(frozenInputs.optionLikeTokens).toEqual([
    "",
    " ",
    "--json",
    "--deadline-ms",
    "--help",
    "--discover",
    "--discover-command",
    "--",
    "-x",
  ]);
  expect(frozenInputs.r18Rejected).toHaveLength(16);
  expect(frozenInputs.r18Admitted).toHaveLength(8);
  expect(
    familyCases("R18").filter((item) => item.id.startsWith("R18.r")),
  ).toHaveLength(16 * 2 * 3);
});
