import { expect } from "bun:test";
import { join } from "node:path";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import type {
  DetectorOutput,
  DetectorSummary,
} from "./fixtures/class-detector-worker.ts";
import { supportingTest } from "./harness.ts";

const preloadPath = join(import.meta.dir, "fixtures", "trace-fs-preload.ts");
const workerPath = join(
  import.meta.dir,
  "fixtures",
  "class-detector-worker.ts",
);

function readNumber(source: object, key: string): number {
  const value: unknown = Object.hasOwn(source, key)
    ? Reflect.get(source, key)
    : undefined;
  if (typeof value !== "number")
    throw new Error(`Detector summary field ${key} must be a number.`);
  return value;
}

function parseSummary(value: unknown): DetectorSummary {
  if (typeof value !== "object" || value === null)
    throw new Error("Detector summary must be an object.");
  return {
    class1RedFindings: readNumber(value, "class1RedFindings"),
    class2RedScenarios: readNumber(value, "class2RedScenarios"),
    class2Scenarios: readNumber(value, "class2Scenarios"),
    class2RedDistinctChanges: readNumber(value, "class2RedDistinctChanges"),
    class2SoftChanges: readNumber(value, "class2SoftChanges"),
    detectorErrors: readNumber(value, "detectorErrors"),
  };
}

function parseOutput(stdout: string): DetectorOutput {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Detector worker returned an unexpected payload.");
  const summary: unknown = Object.hasOwn(parsed, "summary")
    ? Reflect.get(parsed, "summary")
    : undefined;
  const report: unknown = Object.hasOwn(parsed, "report")
    ? Reflect.get(parsed, "report")
    : undefined;
  if (typeof report !== "string")
    throw new Error("Detector worker returned no report string.");
  return { summary: parseSummary(summary), report };
}

supportingTest(
  "SU28.class-detector: no caller object read twice and no durable change after the run answer",
  async () => {
    const run = await spawnBounded(
      [process.execPath, "--preload", preloadPath, workerPath],
      {
        env: { ...process.env },
        boundMilliseconds: 115_000,
      },
    );
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    const { summary, report } = parseOutput(run.stdout);
    const red =
      summary.class1RedFindings > 0 ||
      summary.class2RedScenarios > 0 ||
      summary.class2RedDistinctChanges > 0 ||
      summary.detectorErrors > 0;
    expect(red ? report : summary).toEqual({
      ...summary,
      class1RedFindings: 0,
      class2RedScenarios: 0,
      class2RedDistinctChanges: 0,
      detectorErrors: 0,
    });
  },
  120_000,
);
