import { allCases } from "./harness.ts";

// Which test file exercises each frozen slice A family. The coverage test
// proves every slice A case ID is exercised exactly once.
export const familiesByFile = {
  writer: [
    "W01",
    "W02",
    "W03",
    "W04",
    "W05",
    "F01",
    "F02",
    "F03",
    "F04",
    "X01",
  ],
  lifecycle: [
    "L01",
    "L02",
    "L03",
    "L04",
    "L05",
    "L07",
    "L08",
    "L09",
    "L10",
    "L11",
    "L12",
    "R02",
  ],
  programs: ["P05", "P06", "P07", "P08", "P09", "P10"],
} as const;

export function sliceCases(file: keyof typeof familiesByFile) {
  const families: readonly string[] = familiesByFile[file];
  return allCases.filter(
    (entry) => entry.status === "slice-a" && families.includes(entry.family),
  );
}
