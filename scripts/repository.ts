import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const file = "repository.json";
const fullSha = /^[0-9a-f]{40}$/;
const webAddress = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

export type TestArea = {
  readonly name: string;
  readonly folder: string;
  readonly holds: "files" | "folder";
  readonly subfolders: boolean;
};

export type Repository = {
  readonly web: string;
  readonly checkCommitsSince: string;
  readonly testAreas: readonly TestArea[];
};

function fail(where: string, problem: string): never {
  throw new Error(`${file}: ${where} ${problem}`);
}

function fields(
  value: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(where, "must be an object.");
  const entries = new Map(Object.entries(value));
  const known = [...required, ...optional];
  for (const key of entries.keys())
    if (!known.includes(key))
      fail(where, `has key "${key}". Use only: ${known.join(", ")}.`);
  for (const key of required)
    if (!entries.has(key)) fail(where, `needs key "${key}".`);
  return entries;
}

function text(value: unknown, where: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "")
    fail(where, "must be a non-empty string.");
  if (pattern !== undefined && !pattern.test(value))
    fail(where, `is "${value}", which does not match ${pattern}.`);
  return value;
}

function list(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(where, "must be an array.");
  return value;
}

function testArea(value: unknown, where: string): TestArea {
  const area = fields(
    value,
    where,
    ["name", "folder", "holds"],
    ["subfolders"],
  );
  const holds = area.get("holds");
  if (holds !== "files" && holds !== "folder")
    fail(`${where}.holds`, 'must be "files" or "folder".');
  const subfolders = area.get("subfolders") ?? false;
  if (typeof subfolders !== "boolean")
    fail(`${where}.subfolders`, "must be true or false.");
  return {
    name: text(area.get("name"), `${where}.name`),
    folder: text(area.get("folder"), `${where}.folder`),
    holds,
    subfolders,
  };
}

export function readRepository(root: string): Repository {
  const path = join(root, file);
  if (!existsSync(path))
    throw new Error(
      `${file} is missing at ${root}. Each repository that runs these gates describes itself there: copy the template's and set its web address and test areas.`,
    );
  const description = fields(
    JSON.parse(readFileSync(path, "utf8")),
    "the file",
    ["web", "checkCommitsSince", "testAreas"],
  );
  return {
    web: text(description.get("web"), "web", webAddress),
    checkCommitsSince: text(
      description.get("checkCommitsSince"),
      "checkCommitsSince",
      fullSha,
    ),
    testAreas: list(description.get("testAreas"), "testAreas").map(
      (area, index) => testArea(area, `testAreas[${index}]`),
    ),
  };
}
