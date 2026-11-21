import { expect, test } from "bun:test";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const timingsFile = "tests/test-timings.json";
const done = "Done when bun run test:area standards passes.";

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readTimings(text: string): Map<string, number> {
  const parsed: unknown = JSON.parse(text);
  if (!plainRecord(parsed) || parsed.version !== 1)
    throw new Error(
      `${timingsFile}: needs "version": 1 at its top level. Repair: restore version 1 from a hosted test-timings artifact. ${done}`,
    );
  const files = parsed.files;
  if (!plainRecord(files))
    throw new Error(
      `${timingsFile}: has no "files" object. Repair: add a "files" map of test paths to milliseconds. ${done}`,
    );
  const entries = new Map<string, number>();
  for (const [path, duration] of Object.entries(files)) {
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0
    )
      throw new Error(
        `${timingsFile}: "${path}" needs a non-negative finite millisecond count. Repair: replace it with its measured duration in milliseconds. ${done}`,
      );
    entries.set(path, duration);
  }
  return entries;
}

async function testFilesIn(repository: string): Promise<string[]> {
  const found: string[] = [];
  for await (const path of new Bun.Glob("tests/**/*.test.ts").scan({
    cwd: repository,
    dot: false,
  })) {
    if (lstatSync(join(repository, path)).isFile()) found.push(path);
  }
  return found.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function timingProblems(
  recorded: ReadonlyMap<string, number>,
  actual: readonly string[],
): string[] {
  const actualSet = new Set(actual);
  const missing = actual
    .filter((path) => !recorded.has(path))
    .map(
      (path) =>
        `${timingsFile}: missing timing entry for ${path}. Repair: add its measured duration from the hosted test-timings artifacts so shards stay balanced. ${done}`,
    );
  const stale = [...recorded.keys()]
    .filter((path) => !actualSet.has(path))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      (path) =>
        `${timingsFile}: records ${path}, which no longer exists as a test file. Repair: drop the stale key or rename it to the moved suite. ${done}`,
    );
  return [...missing, ...stale];
}

test("every test file has a timing entry in tests/test-timings.json and no stale timing key remains", async () => {
  const recorded = readTimings(readFileSync(join(root, timingsFile), "utf8"));
  const actual = await testFilesIn(root);
  expect(timingProblems(recorded, actual)).toEqual([]);
});

const fixtureTimings = JSON.stringify({
  version: 1,
  files: {
    "tests/a.test.ts": 120,
    "tests/b.test.ts": 45,
  },
});

test("matching timing keys and test files report no problems", () => {
  expect(
    timingProblems(readTimings(fixtureTimings), [
      "tests/a.test.ts",
      "tests/b.test.ts",
    ]),
  ).toEqual([]);
});

test.each([
  [
    "a test file missing from tests/test-timings.json",
    ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"],
    [
      `${timingsFile}: missing timing entry for tests/c.test.ts. Repair: add its measured duration from the hosted test-timings artifacts so shards stay balanced. ${done}`,
    ],
  ],
  [
    "a stale key left after a suite moved or was deleted",
    ["tests/a.test.ts"],
    [
      `${timingsFile}: records tests/b.test.ts, which no longer exists as a test file. Repair: drop the stale key or rename it to the moved suite. ${done}`,
    ],
  ],
  [
    "a moved suite whose old key stayed behind",
    ["tests/a.test.ts", "tests/moved/b.test.ts"],
    [
      `${timingsFile}: missing timing entry for tests/moved/b.test.ts. Repair: add its measured duration from the hosted test-timings artifacts so shards stay balanced. ${done}`,
      `${timingsFile}: records tests/b.test.ts, which no longer exists as a test file. Repair: drop the stale key or rename it to the moved suite. ${done}`,
    ],
  ],
])("%s fails, naming the path and repair", (_case, actual, expected) => {
  expect(timingProblems(readTimings(fixtureTimings), actual)).toEqual(expected);
});

test.each([
  [
    "a timings file with the wrong version",
    JSON.stringify({ version: 2, files: {} }),
    `${timingsFile}: needs "version": 1 at its top level.`,
  ],
  [
    "a timings file with no files map",
    JSON.stringify({ version: 1 }),
    `${timingsFile}: has no "files" object.`,
  ],
  [
    "a timings entry with a negative duration",
    JSON.stringify({ version: 1, files: { "tests/a.test.ts": -5 } }),
    `${timingsFile}: "tests/a.test.ts" needs a non-negative finite millisecond count.`,
  ],
])("%s is refused, naming the field", (_case, text, message) => {
  expect(() => readTimings(text)).toThrow(message);
});
