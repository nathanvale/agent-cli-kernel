import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const lineBreak = /[\r\n\u2028\u2029]/;
const eslintRule =
  "(?:@[a-z0-9_-]+/)?[a-z0-9][A-Za-z0-9_-]*(?:/[a-z0-9][A-Za-z0-9_-]*)*";
const eslintRuleList = `(?:\\s+${eslintRule}(?:\\s*,\\s*${eslintRule})*)?`;
const eslintReason = "(?:\\s+--\\s+\\S.*)?";
const eslintLineDirective = new RegExp(
  `^eslint-disable(?:-next)?-line${eslintRuleList}${eslintReason}$`,
);
const eslintBlockDirective = new RegExp(
  `^(?:eslint-(?:disable|enable)${eslintRuleList}${eslintReason}|eslint\\s+${eslintRule}\\s*:\\s*\\S.*|globals?\\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*:\\s*(?:readonly|writable|off|true|false))?(?:\\s*,\\s*[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*:\\s*(?:readonly|writable|off|true|false))?)*|exported\\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*,\\s*[A-Za-z_$][A-Za-z0-9_$]*)*)$`,
);
const tsLineOnlyDirective = /^@ts-(?:no)?check$/;
const tsCommentDirective = /^@ts-(?:expect-error|ignore)(?:$|[\s:])/;
const biomeDirective =
  /^biome-ignore(?:-all|-start|-end)?\s+([a-z]+(?:\/[A-Za-z][A-Za-z0-9]*){0,2})(?:\([^()]+\))?:\s*\S/;
const fallowTarget =
  "(?:policy-violation:[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*|[a-z]+(?:-[a-z]+)+)";
const fallowDirective = new RegExp(
  `^fallow-ignore-(?:next-line|file)(?:\\s+${fallowTarget}(?:(?:\\s*,\\s*|\\s+)${fallowTarget})*)?(?:\\s+--\\s+\\S.*)?$`,
);

const biomeMetaKeys = new Set(["preset", "recommended"]);

function collectSchemaRefs(prop) {
  if (!prop) return [];
  const refs = prop.$ref ? [prop.$ref] : [];
  if (!Array.isArray(prop.anyOf)) return refs;
  return refs.concat(prop.anyOf.map((item) => item?.$ref).filter(Boolean));
}

function resolveSchemaDef(ref, defs) {
  const def = defs[ref.replace(/^#\/\$defs\//, "")];
  if (!def) return undefined;
  if (def.properties) return def.properties;
  return Array.isArray(def.anyOf)
    ? resolveSchemaProperties(def, defs)
    : undefined;
}

function resolveSchemaProperties(prop, defs) {
  for (const ref of collectSchemaRefs(prop)) {
    const resolved = resolveSchemaDef(ref, defs);
    if (resolved) return resolved;
  }
  return undefined;
}

function addGroupEntries(categories, prefix, entries) {
  for (const entry of Object.keys(entries)) {
    if (!biomeMetaKeys.has(entry)) {
      categories.add(`${prefix}/${entry}`);
    }
  }
}

function addSectionCategories(categories, section, defs, prefix, includeGroup) {
  const groups = section?.properties;
  if (!groups) return;
  for (const [group, prop] of Object.entries(groups)) {
    if (biomeMetaKeys.has(group)) continue;
    const entries = resolveSchemaProperties(prop, defs);
    if (!entries) continue;
    const groupPrefix = `${prefix}/${group}`;
    if (includeGroup) categories.add(groupPrefix);
    addGroupEntries(categories, groupPrefix, entries);
  }
}

function loadBiomeCategories() {
  const require = createRequire(import.meta.url);
  const schemaPath = require.resolve(
    "@biomejs/biome/configuration_schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const defs = schema.$defs ?? {};
  const categories = new Set(["format", "parse", "lint", "assist"]);
  addSectionCategories(categories, defs.Rules, defs, "lint", true);
  addSectionCategories(categories, defs.Actions, defs, "assist", false);
  return categories;
}

const biomeCategories = loadBiomeCategories();

function isBiomeDirective(text) {
  const match = biomeDirective.exec(text);
  return match !== null && biomeCategories.has(match[1]);
}

function isFallowBlockPlaced(comment, source) {
  if (comment.type !== "Block") return true;
  if (!source) return false;
  const startLine = source.lines[comment.loc.start.line - 1];
  const endLine = source.lines[comment.loc.end.line - 1];
  return (
    startLine !== undefined &&
    endLine !== undefined &&
    startLine.slice(0, comment.loc.start.column).trim() === "" &&
    endLine.slice(comment.loc.end.column).trim() === ""
  );
}

function isDirectiveComment(comment, source) {
  if (lineBreak.test(comment.value)) return false;
  const text = comment.value.trim();
  if (comment.type === "Line" && tsLineOnlyDirective.test(text)) return true;
  if (
    tsCommentDirective.test(text) ||
    isBiomeDirective(text) ||
    (fallowDirective.test(text) && isFallowBlockPlaced(comment, source)) ||
    eslintLineDirective.test(text)
  ) {
    return true;
  }
  return comment.type === "Block" && eslintBlockDirective.test(text);
}

export function isDirectiveBlock(block, source) {
  return block.every((comment) => isDirectiveComment(comment, source));
}
