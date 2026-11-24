import {
  mergeBaseOf,
  optionalTextAt,
  recordedEntries,
  recordedHitsFile,
  recordedUnusedTermsFile,
  textAt,
} from "./glossary.ts";
import { isAbsentError } from "./read-file.ts";

const suppressionsFile = "eslint-suppressions.json";

type Recorded = {
  readonly file: string;
  readonly list: string;
  readonly identity: readonly string[];
  readonly optional?: boolean;
  readonly gate?: string;
  readonly repair?: string;
  readonly describe: (own: ReadonlyMap<string, unknown>) => string;
};

type SuppressionEntry = {
  readonly count: number;
  readonly approved: string | undefined;
};

const recordedLists: readonly Recorded[] = [
  {
    file: recordedHitsFile,
    list: "hits",
    identity: ["path", "word", "declaration"],
    describe: (own) =>
      `a recorded hit for "${String(own.get("word"))}" in ${String(own.get("path"))}${own.get("declaration") === undefined ? "" : ` declaration ${String(own.get("declaration"))}`}`,
  },
  {
    file: recordedUnusedTermsFile,
    list: "terms",
    identity: ["term"],
    describe: (own) => `a recorded unused term "${String(own.get("term"))}"`,
  },
  {
    file: "tests/template/standards/coverage-gaps-recorded-hits.json",
    list: "hits",
    identity: ["path", "export"],
    optional: true,
    gate: "the import-coverage check",
    repair: "import and call it from a test, then remove the entry",
    describe: (own) =>
      `a recorded coverage gap for ${String(own.get("path"))}${own.get("export") === undefined ? "" : ` export ${String(own.get("export"))}`}`,
  },
];

function identityOf(
  own: ReadonlyMap<string, unknown>,
  keys: readonly string[],
) {
  return JSON.stringify(keys.map((key) => own.get(key)));
}

function approvalOf(own: ReadonlyMap<string, unknown>): string | undefined {
  const approved = own.get("approved");
  return typeof approved === "string" && approved.trim() !== ""
    ? approved.trim()
    : undefined;
}

function plainObjectEntries(
  value: unknown,
  where: string,
): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where} must be a JSON object.`);
  return Object.entries(value);
}

function optionalCurrent(read: (path: string) => string, path: string) {
  try {
    return read(path);
  } catch (error) {
    if (isAbsentError(error)) return undefined;
    throw error;
  }
}

function additionProblems(
  {
    file,
    list,
    identity,
    gate = "the names check",
    repair = "remove it (rename the path, or use or remove the term)",
    describe,
  }: Recorded,
  base: string,
  current: string,
  revision: string,
): string[] {
  const before = new Set(
    recordedEntries(file, base, list).map((own) => identityOf(own, identity)),
  );
  return recordedEntries(file, current, list).flatMap((own) =>
    before.has(identityOf(own, identity)) || approvalOf(own) !== undefined
      ? []
      : [
          `${file} adds ${describe(own)}, which ${revision} does not record, so this change widens what ${gate} admits. Repair: ${repair}; or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.`,
        ],
  );
}

function readSuppressions(text: string) {
  const byFile = new Map<string, Map<string, SuppressionEntry>>();
  const byRule = new Map<string, number>();
  for (const [file, raw] of plainObjectEntries(
    JSON.parse(text),
    suppressionsFile,
  )) {
    const entries = new Map<string, SuppressionEntry>();
    for (const [rule, entry] of plainObjectEntries(
      raw,
      `${suppressionsFile}: ${file}`,
    )) {
      const fields = new Map(
        plainObjectEntries(entry, `${suppressionsFile}: ${file} ${rule}`),
      );
      const n = fields.get("count");
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
        throw new Error(
          `${suppressionsFile}: ${file} ${rule} needs a non-negative integer count.`,
        );
      entries.set(rule, { count: n, approved: approvalOf(fields) });
      byRule.set(rule, (byRule.get(rule) ?? 0) + n);
    }
    byFile.set(file, entries);
  }
  return { byFile, byRule };
}

function suppressionGrowthProblems(
  root: string,
  base: string,
  read: (path: string) => string,
  revision: string,
): string[] {
  const current = optionalCurrent(read, suppressionsFile);
  if (current === undefined) return [];
  const before = readSuppressions(
    optionalTextAt(root, base, suppressionsFile) ?? "{}",
  );
  const after = readSuppressions(current);
  return [...after.byRule].flatMap(([rule, afterTotal]) => {
    const beforeTotal = before.byRule.get(rule) ?? 0;
    if (afterTotal <= beforeTotal) return [];
    return [...after.byFile].flatMap(([file, rules]) => {
      const afterEntry = rules.get(rule);
      const afterCount = afterEntry?.count ?? 0;
      const beforeEntry = before.byFile.get(file)?.get(rule);
      const beforeCount = beforeEntry?.count ?? 0;
      if (afterCount <= beforeCount) return [];
      if (
        afterEntry?.approved !== undefined &&
        afterEntry.approved !== beforeEntry?.approved
      )
        return [];
      return [
        `${suppressionsFile} records ${afterCount} ${afterCount === 1 ? "hit" : "hits"} for ${file} ${rule}, more than ${revision} records (${beforeCount}; rule total ${afterTotal} exceeds ${beforeTotal}). Repair: fix the lint violation and run bunx eslint . --prune-suppressions; or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.`,
      ];
    });
  });
}

export function recordedAdditionProblems(
  root: string,
  revision: string,
  currentText: (path: string) => string,
): string[] {
  const base = mergeBaseOf(root, revision);
  return [
    ...recordedLists.flatMap((recorded) => {
      if (!recorded.optional)
        return additionProblems(
          recorded,
          textAt(root, base, recorded.file),
          currentText(recorded.file),
          revision,
        );
      const current = optionalCurrent(currentText, recorded.file);
      if (current === undefined) return [];
      const before =
        optionalTextAt(root, base, recorded.file) ??
        JSON.stringify({ [recorded.list]: [] });
      return additionProblems(recorded, before, current, revision);
    }),
    ...suppressionGrowthProblems(root, base, currentText, revision),
  ];
}
