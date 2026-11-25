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
const biomeCategory = "[a-z]+(?:/[A-Za-z][A-Za-z0-9]*){0,2}(?:\\([^()]+\\))?";
const biomeCategoryToken = new RegExp(biomeCategory, "g");
const biomeDirective = new RegExp(
  `^biome-ignore(?:-all|-start|-end)?\\s+(${biomeCategory}(?:\\s+${biomeCategory})*):\\s*\\S`,
);
const fallowPolicyRule =
  /^policy-violation:[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const fallowTargetList =
  "(?:[a-z0-9][a-z0-9:/-]*(?:(?:\\s*,\\s*|\\s+)[a-z0-9][a-z0-9:/-]*)*)";
const fallowDirective = new RegExp(
  `^fallow-ignore-(?:next-line|file)(?:\\s+(${fallowTargetList}))?(?:\\s+--\\s+\\S.*)?$`,
);
const fallowSuppressComment =
  /^\/\/\s*fallow-ignore-(?:next-line|file)\s+([a-z][a-z0-9-]*)$/;

const biomeMetaKeys = new Set(["preset", "recommended"]);
const biomeSchemaTypes = new Set([
  "string",
  "object",
  "boolean",
  "array",
  "null",
  "integer",
  "number",
]);
const biomeSchemaSpecifier = "@biomejs/biome/configuration_schema.json";
const fallowRegistrySpecifier = "fallow/issue-registry.json";
const fallowUnparsedRegistryIds = new Set(["unused-optional-dependency"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyError(specifier, detail, cause) {
  const message = `Cannot load directive metadata from ${specifier} (${detail}). Repair: reinstall dependencies with bun install --frozen-lockfile.`;
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
}

function readJsonDependency(specifier, filePath) {
  let resolvedPath = filePath;
  if (resolvedPath === undefined) {
    try {
      resolvedPath = createRequire(import.meta.url).resolve(specifier);
    } catch (error) {
      throw dependencyError(specifier, "file missing", error);
    }
  }
  try {
    return JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const detail =
      error instanceof SyntaxError ? "malformed JSON" : "cannot read file";
    throw dependencyError(specifier, detail, error);
  }
}

function collectSchemaRefs(prop) {
  if (!isRecord(prop)) return [];
  const refs = typeof prop.$ref === "string" ? [prop.$ref] : [];
  if (!Array.isArray(prop.anyOf)) return refs;
  return refs.concat(
    prop.anyOf
      .map((item) =>
        isRecord(item) && typeof item.$ref === "string" ? item.$ref : "",
      )
      .filter(Boolean),
  );
}

function resolveSchemaDefinition(ref, defs, seen) {
  const name = ref.replace(/^#\/\$defs\//, "");
  if (seen.has(name)) return undefined;
  seen.add(name);
  const def = Object.hasOwn(defs, name) ? defs[name] : undefined;
  if (!isRecord(def)) return undefined;
  if (isRecord(def.properties)) return def.properties;
  return Array.isArray(def.anyOf)
    ? resolveSchemaProperties(def, defs, seen)
    : undefined;
}

function resolveSchemaProperties(prop, defs, seen = new Set()) {
  for (const ref of collectSchemaRefs(prop)) {
    const resolved = resolveSchemaDefinition(ref, defs, seen);
    if (resolved) return resolved;
  }
  return undefined;
}

function isValidSchemaType(type) {
  if (typeof type === "string") return biomeSchemaTypes.has(type);
  return (
    Array.isArray(type) &&
    type.length > 0 &&
    type.every((item) => typeof item === "string" && biomeSchemaTypes.has(item))
  );
}

function isValidSchemaList(list, defs, seen, validated) {
  return (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((item) => isValidSchemaNode(item, defs, seen, validated))
  );
}

function isValidSchemaCombinators(node, defs, seen, validated) {
  if (
    node.oneOf !== undefined &&
    !isValidSchemaList(node.oneOf, defs, seen, validated)
  ) {
    return false;
  }
  return (
    node.anyOf === undefined ||
    isValidSchemaList(node.anyOf, defs, seen, validated)
  );
}

function isValidSchemaChildren(node, defs, seen, validated) {
  if (
    node.properties !== undefined &&
    (!isRecord(node.properties) ||
      !Object.values(node.properties).every((child) =>
        isValidSchemaNode(child, defs, seen, validated),
      ))
  ) {
    return false;
  }
  if (
    node.items !== undefined &&
    !isValidSchemaNode(node.items, defs, seen, validated)
  ) {
    return false;
  }
  return (
    node.additionalProperties === undefined ||
    typeof node.additionalProperties === "boolean" ||
    isValidSchemaNode(node.additionalProperties, defs, seen, validated)
  );
}

function hasSchemaKeyword(node) {
  return (
    node.oneOf !== undefined ||
    node.anyOf !== undefined ||
    node.$ref !== undefined ||
    node.type !== undefined
  );
}

function isValidSchemaNode(node, defs, seen, validated) {
  if (!isRecord(node) || !hasSchemaKeyword(node)) return false;
  if (!isValidSchemaCombinators(node, defs, seen, validated)) return false;
  if (
    node.$ref !== undefined &&
    !isValidSchemaRef(node.$ref, defs, seen, validated)
  ) {
    return false;
  }
  if (node.type !== undefined && !isValidSchemaType(node.type)) return false;
  return isValidSchemaChildren(node, defs, seen, validated);
}

function isValidSchemaRef(ref, defs, seen = new Set(), validated = new Set()) {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return false;
  const name = ref.slice("#/$defs/".length);
  if (name.length === 0 || !Object.hasOwn(defs, name)) return false;
  if (validated.has(name)) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const valid = isValidSchemaNode(defs[name], defs, seen, validated);
  seen.delete(name);
  if (valid) validated.add(name);
  return valid;
}

function hasValidEntryDefinition(prop, defs, validated) {
  if (!isValidSchemaNode(prop, defs, new Set(), validated)) return false;
  const refs = collectSchemaRefs(prop);
  return (
    refs.length > 0 &&
    refs.every((ref) => isValidSchemaRef(ref, defs, new Set(), validated))
  );
}

function addGroupEntries(
  categories,
  prefix,
  entries,
  defs,
  groupLabel,
  validated,
) {
  let added = 0;
  for (const [entry, prop] of Object.entries(entries)) {
    if (biomeMetaKeys.has(entry)) continue;
    if (!hasValidEntryDefinition(prop, defs, validated)) {
      throw dependencyError(
        biomeSchemaSpecifier,
        `invalid ${groupLabel}.${entry}`,
      );
    }
    categories.add(`${prefix}/${entry}`);
    added += 1;
  }
  return added;
}

function addSectionCategories(
  categories,
  section,
  defs,
  prefix,
  includeGroup,
  name,
) {
  const groups = isRecord(section) ? section.properties : undefined;
  if (!isRecord(groups))
    throw dependencyError(biomeSchemaSpecifier, `missing ${name}`);
  const validated = new Set();
  let addedGroups = 0;
  for (const [group, prop] of Object.entries(groups)) {
    if (biomeMetaKeys.has(group)) continue;
    const entries = resolveSchemaProperties(prop, defs);
    if (!isRecord(entries)) {
      throw dependencyError(
        biomeSchemaSpecifier,
        `unresolved ${name}.${group}`,
      );
    }
    const groupPrefix = `${prefix}/${group}`;
    if (includeGroup) categories.add(groupPrefix);
    if (
      addGroupEntries(
        categories,
        groupPrefix,
        entries,
        defs,
        `${name}.${group}`,
        validated,
      ) === 0
    ) {
      throw dependencyError(biomeSchemaSpecifier, `empty ${name}.${group}`);
    }
    addedGroups += 1;
  }
  if (addedGroups === 0)
    throw dependencyError(biomeSchemaSpecifier, `empty ${name}`);
}

export function loadBiomeCategories(schemaPath) {
  const schema = readJsonDependency(biomeSchemaSpecifier, schemaPath);
  if (!isRecord(schema) || !isRecord(schema.$defs)) {
    throw dependencyError(biomeSchemaSpecifier, "missing $defs");
  }
  const defs = schema.$defs;
  const categories = new Set(["format", "parse", "lint", "assist"]);
  addSectionCategories(categories, defs.Rules, defs, "lint", true, "Rules");
  addSectionCategories(
    categories,
    defs.Actions,
    defs,
    "assist",
    false,
    "Actions",
  );
  return categories;
}

function addFallowAliases(targets, aliases) {
  if (!Array.isArray(aliases)) return;
  for (const alias of aliases) {
    if (typeof alias === "string" && alias.length > 0) targets.add(alias);
  }
}

function addFallowRegistryTarget(targets, item) {
  if (typeof item.registry_index !== "number") return;
  if (typeof item.id !== "string" || item.id.length === 0) return;
  if (fallowUnparsedRegistryIds.has(item.id)) return;
  targets.add(item.id);
  addFallowAliases(targets, item.aliases);
}

function addFallowIssueTargets(targets, item) {
  if (!isRecord(item)) return;
  if (typeof item.suppress_comment !== "string") {
    addFallowRegistryTarget(targets, item);
    return;
  }
  const match = fallowSuppressComment.exec(item.suppress_comment);
  if (match === null) return;
  targets.add(match[1]);
  if (item.id === match[1]) addFallowAliases(targets, item.aliases);
}

export function loadFallowTargets(registryPath) {
  const registry = readJsonDependency(fallowRegistrySpecifier, registryPath);
  if (!isRecord(registry) || !Array.isArray(registry.issue_types)) {
    throw dependencyError(fallowRegistrySpecifier, "missing issue_types");
  }
  const targets = new Set();
  for (const item of registry.issue_types) {
    addFallowIssueTargets(targets, item);
  }
  if (targets.size === 0)
    throw dependencyError(fallowRegistrySpecifier, "empty targets");
  return targets;
}

const biomeCategories = loadBiomeCategories();
const fallowTargets = loadFallowTargets();

function isBiomeDirective(text) {
  const match = biomeDirective.exec(text);
  const entries = match === null ? null : match[1].match(biomeCategoryToken);
  return (
    entries !== null &&
    entries.every((entry) =>
      biomeCategories.has(entry.replace(/\([^()]+\)$/, "")),
    )
  );
}

function isFallowDirective(text) {
  const match = fallowDirective.exec(text);
  if (match === null) return false;
  if (match[1] === undefined) return true;
  return match[1]
    .split(/[\s,]+/)
    .every(
      (target) => fallowTargets.has(target) || fallowPolicyRule.test(target),
    );
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

function isFallowComment(comment, text, source) {
  return isFallowDirective(text) && isFallowBlockPlaced(comment, source);
}

function isDirectiveComment(comment, source) {
  if (lineBreak.test(comment.value)) return false;
  const text = comment.value.trim();
  if (comment.type === "Line" && tsLineOnlyDirective.test(text)) return true;
  if (
    tsCommentDirective.test(text) ||
    isBiomeDirective(text) ||
    isFallowComment(comment, text, source) ||
    eslintLineDirective.test(text)
  ) {
    return true;
  }
  return comment.type === "Block" && eslintBlockDirective.test(text);
}

export function isDirectiveBlock(block, source) {
  return block.every((comment) => isDirectiveComment(comment, source));
}
