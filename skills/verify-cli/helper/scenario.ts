import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import type { JsonValue } from "agent-cli-kernel";
import { at, listOf, parsedJson } from "./json.ts";
import { scenarioSchema, targetLimits } from "./place.ts";

const scenarioBytesLimit = 1_048_576;
const stepCountLimit = 200;
const stepTimeoutLimit = 600_000;
const stepOutputLimit = 8_388_608;
const scenarioTimeLimit = 3_600_000;
const nameShape = /^[a-z0-9-]{1,64}$/;

export type FileExpectation = {
  readonly path: string;
  readonly content?: string;
  readonly absent?: true;
};

export type Expectations = {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly result?: Readonly<Record<string, JsonValue>>;
  readonly files?: readonly FileExpectation[];
  readonly timedOut?: boolean;
  readonly stdoutIncludes?: readonly string[];
  readonly stderrIncludes?: readonly string[];
};

export type ScenarioStep = {
  readonly name: string;
  readonly runner: "target" | "bun";
  readonly argv: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly outputLimitBytes: number;
  readonly expect: Expectations;
};

export type Scenario = {
  readonly feature: string;
  readonly steps: readonly ScenarioStep[];
};

export type ScenarioRead =
  | { readonly kind: "read"; readonly scenario: Scenario }
  | { readonly kind: "broken"; readonly rule: string; readonly detail: string };

class Broken extends Error {
  constructor(
    readonly rule: string,
    detail: string,
  ) {
    super(detail);
  }
}

function fail(rule: string, detail: string): never {
  throw new Broken(rule, detail);
}

function record(value: unknown, where: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("bad-value", `${where} must be an object`);
  return value;
}

function onlyFields(
  value: object,
  names: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value))
    if (!names.includes(key))
      fail(
        "unknown-field",
        `${where} has the field ${key}, which the format does not name`,
      );
}

function strings(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value))
    fail("bad-value", `${where} must be a list of strings`);
  const items = listOf(value);
  if (!items.every((item) => typeof item === "string"))
    fail("bad-value", `${where} must be a list of strings`);
  return items.map(String);
}

function optionalText(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail("bad-value", `${where} must be a string`);
  return value;
}

function limit(
  value: unknown,
  fallback: number,
  most: number,
  where: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    fail("bad-value", `${where} must be a whole number`);
  if (value < 1 || value > most)
    fail(
      "limit-out-of-range",
      `${where} is ${String(value)}, outside 1 to ${String(most)}`,
    );
  return value;
}

function name(value: unknown, where: string): string {
  if (typeof value !== "string" || !nameShape.test(value))
    fail(
      "bad-name",
      `${where} must be 1 to 64 lower-case letters, digits and hyphens`,
    );
  return value;
}

export function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return listOf(value).map((item) => jsonValue(item));
  const entries: [string, JsonValue][] = Object.entries(
    record(value, "a result value"),
  ).map(([key, item]: [string, unknown]) => [key, jsonValue(item)]);
  return Object.fromEntries(entries);
}

const fileFields = ["path", "content", "absent"];

function fileExpectation(value: unknown, where: string): FileExpectation {
  const entry = record(value, where);
  onlyFields(entry, fileFields, where);
  const path = optionalText(at(entry, "path"), `${where}.path`) ?? "";
  const content = optionalText(at(entry, "content"), `${where}.content`);
  const absent = at(entry, "absent");
  if (!path.startsWith("{scratch}/") || path.split("/").includes(".."))
    fail(
      "path-outside-scratch",
      `${where}.path ${JSON.stringify(path)} must start {scratch}/ and hold no .. segment`,
    );
  if (content !== undefined && absent === undefined) return { path, content };
  if (absent === true && content === undefined) return { path, absent: true };
  return fail("bad-value", `${where} must hold content, or "absent": true`);
}

const expectFields = [
  "exitCode",
  "stdout",
  "stderr",
  "result",
  "files",
  "timedOut",
  "stdoutIncludes",
  "stderrIncludes",
];

type Given = {
  readonly exitCode: unknown;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly result: unknown;
  readonly files: unknown;
  readonly timedOut: unknown;
  readonly stdoutIncludes: unknown;
  readonly stderrIncludes: unknown;
};

function givenExpectations(entry: object, where: string): Given {
  return {
    exitCode: at(entry, "exitCode"),
    stdout: optionalText(at(entry, "stdout"), `${where}.stdout`),
    stderr: optionalText(at(entry, "stderr"), `${where}.stderr`),
    result: at(entry, "result"),
    files: at(entry, "files"),
    timedOut: at(entry, "timedOut"),
    stdoutIncludes: at(entry, "stdoutIncludes"),
    stderrIncludes: at(entry, "stderrIncludes"),
  };
}

function resultExpectation(value: unknown, where: string) {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record(value, where)).map(
      ([key, item]: [string, unknown]) => [key, jsonValue(item)],
    ),
  );
}

function fileExpectations(value: unknown, where: string) {
  if (value === undefined) return undefined;
  const items = Array.isArray(value)
    ? listOf(value)
    : fail("bad-value", `${where} must be a list`);
  return items.map((item, index) =>
    fileExpectation(item, `${where}.${String(index)}`),
  );
}

function includesExpectation(value: unknown, where: string) {
  return value === undefined ? undefined : strings(value, where);
}

function presentIf<const Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  const field: Partial<Record<Key, Value>> = {};
  if (value !== undefined) field[key] = value;
  return field;
}

function nonEmpty(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function expectations(
  value: unknown,
  runner: "target" | "bun",
  where: string,
): Expectations {
  const entry = record(value, where);
  onlyFields(entry, expectFields, where);
  const given = givenExpectations(entry, where);
  if (
    runner === "target" &&
    (given.stdoutIncludes !== undefined || given.stderrIncludes !== undefined)
  )
    fail(
      "includes-on-target-step",
      `${where} has stdoutIncludes or stderrIncludes on a target step, which must be exact`,
    );
  if (given.timedOut !== undefined && typeof given.timedOut !== "boolean")
    fail("bad-value", `${where}.timedOut must be true or false`);
  const result = resultExpectation(given.result, `${where}.result`);
  const files = fileExpectations(given.files, `${where}.files`);
  const stdoutIncludes = includesExpectation(
    given.stdoutIncludes,
    `${where}.stdoutIncludes`,
  );
  const stderrIncludes = includesExpectation(
    given.stderrIncludes,
    `${where}.stderrIncludes`,
  );
  const observes =
    given.stdout !== undefined ||
    given.stderr !== undefined ||
    [result, files, stdoutIncludes, stderrIncludes].some(nonEmpty);
  if (given.exitCode === undefined || !observes)
    fail(
      "exit-code-only",
      `${where} must hold exitCode and at least one expectation on stdout, stderr, the result or a file`,
    );
  if (
    typeof given.exitCode !== "number" ||
    !Number.isSafeInteger(given.exitCode)
  )
    fail("bad-value", `${where}.exitCode must be a whole number`);
  return {
    exitCode: given.exitCode,
    ...presentIf(
      "timedOut",
      typeof given.timedOut === "boolean" ? given.timedOut : undefined,
    ),
    ...presentIf("stdout", given.stdout),
    ...presentIf("stderr", given.stderr),
    ...presentIf("result", result),
    ...presentIf("files", files),
    ...presentIf("stdoutIncludes", stdoutIncludes),
    ...presentIf("stderrIncludes", stderrIncludes),
  };
}

function optionalField<const Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  const field: Partial<Record<Key, string>> = {};
  if (value !== undefined) field[key] = value;
  return field;
}

const stepFields = [
  "name",
  "argv",
  "expect",
  "runner",
  "timeoutMilliseconds",
  "outputLimitBytes",
];

function scenarioStep(value: unknown, index: number): ScenarioStep {
  const where = `steps.${String(index)}`;
  const entry = record(value, where);
  onlyFields(entry, stepFields, where);
  const runner = at(entry, "runner") ?? "target";
  if (runner !== "target" && runner !== "bun")
    fail("bad-value", `${where}.runner must be "bun" or absent`);
  return {
    name: name(at(entry, "name"), `${where}.name`),
    runner,
    argv: strings(at(entry, "argv"), `${where}.argv`),
    timeoutMilliseconds: limit(
      at(entry, "timeoutMilliseconds"),
      targetLimits.timeoutMilliseconds,
      stepTimeoutLimit,
      `${where}.timeoutMilliseconds`,
    ),
    outputLimitBytes: limit(
      at(entry, "outputLimitBytes"),
      targetLimits.outputLimitBytes,
      stepOutputLimit,
      `${where}.outputLimitBytes`,
    ),
    expect: expectations(at(entry, "expect"), runner, `${where}.expect`),
  };
}

export function scenarioOf(value: unknown): Scenario {
  const top = record(value, "the scenario");
  onlyFields(top, ["schema", "feature", "steps"], "the scenario");
  if (at(top, "schema") !== scenarioSchema)
    fail("unknown-field", `the scenario's schema must be ${scenarioSchema}`);
  const feature = name(at(top, "feature"), "feature");
  const listed = at(top, "steps");
  if (!Array.isArray(listed)) fail("bad-value", "steps must be a list");
  const items = listOf(listed);
  if (items.length === 0 || items.length > stepCountLimit)
    fail(
      "step-count",
      `the scenario has ${String(items.length)} steps; it needs 1 to ${String(stepCountLimit)}`,
    );
  const steps = items.map((item, index) => scenarioStep(item, index));
  const names = new Set<string>();
  for (const step of steps) {
    if (names.has(step.name))
      fail("duplicate-step", `two steps are named ${step.name}`);
    names.add(step.name);
  }
  const total = steps.reduce((sum, step) => sum + step.timeoutMilliseconds, 0);
  if (total > scenarioTimeLimit)
    fail(
      "limit-out-of-range",
      `the steps' time limits sum to ${String(total)} ms, past ${String(scenarioTimeLimit)}`,
    );
  return { feature, steps };
}

function readFailure(error: unknown): string {
  return at(error, "code") === "ENOENT"
    ? "is missing"
    : `cannot be read: ${error instanceof Error ? error.message : String(error)}`;
}

export function readScenario(path: string): ScenarioRead {
  try {
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch (error) {
      return fail("unreadable", `${path} ${readFailure(error)}`);
    }
    if (!stats.isFile()) fail("unreadable", `${path} is not a regular file`);
    if (stats.size > scenarioBytesLimit)
      fail(
        "unreadable",
        `${path} is ${String(stats.size)} bytes, over ${String(scenarioBytesLimit)}`,
      );
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      return fail("unreadable", `${path} ${readFailure(error)}`);
    }
    const parsed = parsedJson(text);
    if (parsed === undefined) fail("unreadable", `${path} is not JSON`);
    return { kind: "read", scenario: deepFrozen(scenarioOf(parsed)) };
  } catch (error) {
    if (error instanceof Broken)
      return { kind: "broken", rule: error.rule, detail: error.message };
    throw error;
  }
}

function deepFrozen<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFrozen(item);
    Object.freeze(value);
  }
  return value;
}

export type Places = {
  readonly scratch: string;
  readonly repository: string;
};

function placed(text: string, places: Places): string {
  return text
    .replaceAll("{scratch}", places.scratch)
    .replaceAll("{repository}", places.repository);
}

function placedValue(value: JsonValue, places: Places): JsonValue {
  if (typeof value === "string") return placed(value, places);
  if (Array.isArray(value))
    return value.map((item: JsonValue) => placedValue(item, places));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        placedValue(item, places),
      ]),
    );
  return value;
}

export function placedStep(step: ScenarioStep, places: Places): ScenarioStep {
  const expect = step.expect;
  return {
    ...step,
    argv: step.argv.map((word) => placed(word, places)),
    expect: {
      ...expect,
      ...optionalField(
        "stdout",
        expect.stdout === undefined ? undefined : placed(expect.stdout, places),
      ),
      ...optionalField(
        "stderr",
        expect.stderr === undefined ? undefined : placed(expect.stderr, places),
      ),
      ...(expect.result === undefined
        ? {}
        : {
            result: Object.fromEntries(
              Object.entries(expect.result).map(([key, item]) => [
                key,
                placedValue(item, places),
              ]),
            ),
          }),
      ...(expect.files === undefined
        ? {}
        : {
            files: expect.files.map((file) =>
              file.content === undefined
                ? { ...file, path: placed(file.path, places) }
                : {
                    ...file,
                    path: placed(file.path, places),
                    content: placed(file.content, places),
                  },
            ),
          }),
      ...(expect.stdoutIncludes === undefined
        ? {}
        : {
            stdoutIncludes: expect.stdoutIncludes.map((text) =>
              placed(text, places),
            ),
          }),
      ...(expect.stderrIncludes === undefined
        ? {}
        : {
            stderrIncludes: expect.stderrIncludes.map((text) =>
              placed(text, places),
            ),
          }),
    },
  };
}
