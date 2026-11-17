export const reviewSpecimens = [
  {
    id: "conversion-overload",
    source:
      "export function convert(value: unknown): { exitCode: 3 }; export function convert(value: unknown): unknown { void value; return { exitCode: 42 }; }",
    finding:
      "GATE-4: overload converts an unchecked body returning exit 42 into a promised exit 3 result.",
  },
  {
    id: "partial-record",
    source:
      'export function classify(value: "success" | "refused") { const table: Partial<Record<typeof value, number>> = { success: 0 }; return table[value] ?? 1; }',
    finding:
      "GATE-11: partial lookup hides a missing refused member behind a fallback.",
  },
  {
    id: "map-fallback",
    source:
      'export function classify(value: "success" | "refused") { const table = new Map([["success", 0]]); return table.get(value) ?? 1; }',
    finding: "GATE-11: Map fallback does not exhaust the closed outcome union.",
  },
  {
    id: "ternary-fallback",
    source:
      'export function classify(value: "success" | "refused") { return value === "success" ? 0 : 1; }',
    finding:
      "GATE-11: ternary fallback hides the refused member and future closed-union additions.",
  },
  {
    id: "in-check",
    source:
      'export function classify(value: "success" | "refused") { return value in { success: 0 } ? 0 : 1; }',
    finding:
      "GATE-11: in check is not a legal exhaustive form for a closed outcome union.",
  },
  {
    id: "if-without-never",
    source:
      'export function classify(value: "success" | "refused") { if (value === "success") return 0; return 1; }',
    finding:
      "GATE-11: if chain lacks assertNever and silently accepts unhandled members.",
  },
  {
    id: "assign-alias",
    source:
      "const assign = Object.assign; export const value = assign({}, { exitCode: 42 });",
    finding:
      "GATE-14 coverage limit: alias evades the direct-call selector; runtime validation remains mandatory.",
  },
] as const;
