import { posix } from "node:path";
import type ts from "typescript";
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
const repositoryRulePrefix = "repository/";
const repositoryRuleModules = [
  "config/template-rules.mjs",
  "config/platform-rules.mjs",
  "config/payload-rules.mjs",
  "config/kernel-repository-rules.mjs",
  "kernel/config/kernel/eslint-rules.mjs",
];

type Recorded = {
  readonly file: string;
  readonly list: string;
  readonly identity: readonly string[];
  readonly optional?: boolean;
  readonly gate?: string;
  readonly repair?: string;
  readonly describe: (own: ReadonlyMap<string, unknown>) => string;
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

function isApproved(own: ReadonlyMap<string, unknown>): boolean {
  const approved = own.get("approved");
  return typeof approved === "string" && approved.trim() !== "";
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
    before.has(identityOf(own, identity)) || isApproved(own)
      ? []
      : [
          `${file} adds ${describe(own)}, which ${revision} does not record, so this change widens what ${gate} admits. Repair: ${repair}; or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.`,
        ],
  );
}

function readSuppressions(text: string) {
  const byFile = new Map<string, Map<string, number>>();
  const byRule = new Map<string, number>();
  for (const [file, raw] of plainObjectEntries(
    JSON.parse(text),
    suppressionsFile,
  )) {
    const counts = new Map<string, number>();
    for (const [rule, entry] of plainObjectEntries(
      raw,
      `${suppressionsFile}: ${file}`,
    )) {
      const n = new Map(
        plainObjectEntries(entry, `${suppressionsFile}: ${file} ${rule}`),
      ).get("count");
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
        throw new Error(
          `${suppressionsFile}: ${file} ${rule} needs a non-negative integer count.`,
        );
      counts.set(rule, n);
      byRule.set(rule, (byRule.get(rule) ?? 0) + n);
    }
    byFile.set(file, counts);
  }
  return { byFile, byRule };
}

type TypeScript = typeof ts;

function keyOf(ts: TypeScript, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  const node = ts.isComputedPropertyName(name) ? name.expression : name;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function rulesObjectOf(ts: TypeScript, source: ts.SourceFile) {
  const def = source.statements.find(ts.isExportAssignment);
  const obj = def && !def.isExportEquals ? def.expression : undefined;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  if (obj.properties.some(ts.isSpreadAssignment)) return undefined;
  const prop = obj.properties.find(
    (p) => ts.isPropertyAssignment(p) && keyOf(ts, p.name) === "rules",
  );
  return prop &&
    ts.isPropertyAssignment(prop) &&
    ts.isObjectLiteralExpression(prop.initializer)
    ? prop.initializer
    : undefined;
}

function ruleNameOf(
  ts: TypeScript,
  prop: ts.ObjectLiteralElementLike,
  imports: ReadonlySet<string>,
): string | null | undefined {
  if (ts.isSpreadAssignment(prop)) {
    const e = prop.expression;
    return ts.isPropertyAccessExpression(e) &&
      e.name.text === "rules" &&
      ts.isIdentifier(e.expression) &&
      imports.has(e.expression.text)
      ? null
      : undefined;
  }
  return ts.isPropertyAssignment(prop) ||
    ts.isMethodDeclaration(prop) ||
    ts.isShorthandPropertyAssignment(prop)
    ? keyOf(ts, prop.name)
    : undefined;
}

function exportedRuleNames(ts: TypeScript, path: string, text: string) {
  const opts = { reportDiagnostics: true, compilerOptions: { allowJs: true } };
  if (ts.transpileModule(text, opts).diagnostics?.length) return undefined;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  const rules = rulesObjectOf(ts, source);
  if (!rules) return undefined;
  const dir = posix.dirname(path);
  const imports = new Set(
    source.statements.flatMap((s) =>
      ts.isImportDeclaration(s) &&
      s.importClause?.name &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      repositoryRuleModules.includes(
        posix.normalize(posix.join(dir, s.moduleSpecifier.text)),
      )
        ? [s.importClause.name.text]
        : [],
    ),
  );
  const names = new Set<string>();
  for (const prop of rules.properties) {
    const name = ruleNameOf(ts, prop, imports);
    if (name === undefined) return undefined;
    if (name !== null) names.add(name);
  }
  return names;
}

function definedRules(
  ts: TypeScript,
  read: (path: string) => string | undefined,
) {
  const names = new Set<string>();
  for (const file of repositoryRuleModules) {
    const text = read(file);
    if (text === undefined) continue;
    const found = exportedRuleNames(ts, file, text);
    if (!found) return undefined;
    for (const name of found) names.add(name);
  }
  return names;
}

async function isNewRule(
  root: string,
  base: string,
  read: (path: string) => string,
  rule: string,
) {
  if (!rule.startsWith(repositoryRulePrefix)) return false;
  const { default: parser } = await import("typescript");
  const name = rule.slice(repositoryRulePrefix.length);
  const before = definedRules(parser, (f) => optionalTextAt(root, base, f));
  const after = definedRules(parser, (f) => optionalCurrent(read, f));
  return Boolean(before && after && !before.has(name) && after.has(name));
}

async function suppressionGrowthProblems(
  root: string,
  base: string,
  read: (path: string) => string,
  revision: string,
): Promise<string[]> {
  const current = optionalCurrent(read, suppressionsFile);
  if (current === undefined) return [];
  const before = readSuppressions(
    optionalTextAt(root, base, suppressionsFile) ?? "{}",
  );
  const after = readSuppressions(current);
  const groups = await Promise.all(
    [...after.byRule].map(async ([rule, afterTotal]) => {
      const beforeTotal = before.byRule.get(rule) ?? 0;
      if (afterTotal <= beforeTotal) return [];
      if (beforeTotal === 0 && (await isNewRule(root, base, read, rule)))
        return [];
      return [...after.byFile].flatMap(([file, rules]) => {
        const afterCount = rules.get(rule) ?? 0;
        const beforeCount = before.byFile.get(file)?.get(rule) ?? 0;
        return afterCount > beforeCount
          ? [
              `${suppressionsFile} records ${afterCount} ${afterCount === 1 ? "hit" : "hits"} for ${file} ${rule}, more than ${revision} records (${beforeCount}; rule total ${afterTotal} exceeds ${beforeTotal}). Repair: fix the lint violation and run bunx eslint . --prune-suppressions.`,
            ]
          : [];
      });
    }),
  );
  return groups.flat();
}

export async function recordedAdditionProblems(
  root: string,
  revision: string,
  currentText: (path: string) => string,
): Promise<string[]> {
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
    ...(await suppressionGrowthProblems(root, base, currentText, revision)),
  ];
}
