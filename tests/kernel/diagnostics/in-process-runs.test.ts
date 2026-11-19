import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "node:path";
import {
  configureSync,
  getConfig,
  getLogger,
  resetSync,
} from "@logtape/logtape";
import type { LogRecord } from "@logtape/logtape";
import type { JsonValue } from "../../../kernel/src/kernel/index.ts";
import { cleanTrees, get, lines, observe, runCrash, tree } from "./harness.ts";
import type { Tree } from "./harness.ts";
import { attachedIn, fixtureChildBound } from "./support.ts";

afterAll(cleanTrees);
beforeEach(resetSync);
afterEach(resetSync);
const timeout = 60_000;
const entry = join(import.meta.dir, "fixtures/in-process-runs-cli.ts");

function writtenBy(where: Tree, runId: string) {
  const path = join(where.dir, `${runId}.jsonl`);
  const log = observe(where.dir).files.find((entry) => entry.path === path);
  if (!log) throw new Error(`Run ${runId} wrote no diagnostics file.`);
  return lines(log.path).map((line) => ({
    runId: get(line, "runId"),
    event: get(line, "event"),
  }));
}

function throwing(): JsonValue {
  const facts: Record<string, JsonValue> = {};
  Object.defineProperty(facts, "boom", {
    enumerable: true,
    get() {
      throw new Error("A getter that throws while it is redacted.");
    },
  });
  return facts;
}

function nested(depth: number): JsonValue {
  let value: JsonValue = "leaf";
  for (let level = 0; level < depth; level += 1) value = { next: value };
  return value;
}

describe("in-process runs of the diagnostics add-on", () => {
  test(
    "two overlapping in-process runs through runInProcess each write only their own log lines",
    async () => {
      const where = tree();
      const result = await runCrash(
        { argv: [], tree: where, entry },
        fixtureChildBound,
      );
      expect({ exit: result.exit, stderr: result.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      const runs = get(result.envelope, "runs");
      if (!Array.isArray(runs) || runs.length !== 2)
        throw new Error("The fixture reported no two runs.");
      for (const run of runs) {
        const runId = String(get(run, "runId"));
        expect({
          kind: get(run, "kind"),
          exitCode: get(run, "exitCode"),
        }).toEqual({ kind: "envelope", exitCode: 0 });
        expect(writtenBy(where, runId)).toEqual([
          { runId, event: "opened" },
          { runId, event: "continued" },
        ]);
        const status = get(run, "envelope", "diagnostics");
        expect({
          dropped: get(status, "droppedRecords"),
          complete: get(status, "countsComplete"),
          closed: get(status, "closed"),
        }).toEqual({ dropped: 0, complete: true, closed: true });
      }
    },
    timeout,
  );

  test(
    "a run leaves the tool's own LogTape configuration in place, and the tool's logger still reaches its sink",
    async () => {
      const where = tree();
      const reached: LogRecord[] = [];
      configureSync({
        sinks: { tool: (record: LogRecord) => reached.push(record) },
        loggers: [
          { category: [], sinks: ["tool"], lowestLevel: "trace" },
          {
            category: ["logtape", "meta"],
            sinks: ["tool"],
            lowestLevel: "warning",
            parentSinks: "override",
          },
        ],
      });
      const toolConfiguration = getConfig();
      const toolLogger = getLogger(["tool"]);
      toolLogger.info("before the run");
      const { runId, attached } = attachedIn(where);
      attached.capability.record("step", { index: 1 });
      await attached.freeze(500);
      toolLogger.info("after the run");
      expect(
        reached.map((record) => ({
          category: record.category,
          message: record.rawMessage,
        })),
      ).toEqual([
        { category: ["tool"], message: "before the run" },
        { category: ["tool"], message: "after the run" },
      ]);
      expect(getConfig()).toBe(toolConfiguration);
      expect(writtenBy(where, runId)).toEqual([{ runId, event: "step" }]);
    },
    timeout,
  );

  test(
    "a run in a process with no LogTape configuration leaves none behind",
    async () => {
      expect(getConfig()).toBeNull();
      const where = tree();
      const { runId, attached } = attachedIn(where);
      attached.capability.record("step", { index: 1 });
      await attached.freeze(500);
      expect(getConfig()).toBeNull();
      expect(writtenBy(where, runId)).toEqual([{ runId, event: "step" }]);
    },
    timeout,
  );

  test(
    "a record past LogTape's redaction depth still marks only its own run's counts incomplete",
    async () => {
      const where = tree();
      const deep = attachedIn(where);
      const plain = attachedIn(where);
      deep.attached.capability.record("deep", { deep: nested(17) });
      plain.attached.capability.record("plain", { index: 1 });
      const [deepStatus, plainStatus] = await Promise.all([
        deep.attached.freeze(500),
        plain.attached.freeze(500),
      ]);
      expect({
        complete: get(deepStatus, "countsComplete"),
        truncated: get(deepStatus, "truncatedRecords"),
      }).toEqual({ complete: false, truncated: 1 });
      expect(get(plainStatus, "countsComplete")).toBe(true);
    },
    timeout,
  );

  test(
    "a record whose facts throw while redacted is dropped and marks only its own run's counts incomplete",
    async () => {
      const where = tree();
      const failing = attachedIn(where);
      const plain = attachedIn(where);
      failing.attached.capability.record("throwing", throwing());
      plain.attached.capability.record("plain", { index: 1 });
      const [failingStatus, plainStatus] = await Promise.all([
        failing.attached.freeze(500),
        plain.attached.freeze(500),
      ]);
      expect({
        complete: get(failingStatus, "countsComplete"),
        dropped: get(failingStatus, "droppedRecords"),
      }).toEqual({ complete: false, dropped: 1 });
      expect({
        complete: get(plainStatus, "countsComplete"),
        dropped: get(plainStatus, "droppedRecords"),
      }).toEqual({ complete: true, dropped: 0 });
    },
    timeout,
  );

  test(
    "a record at the add-on's own depth bound is truncated, and its counts stay complete",
    async () => {
      const { attached } = attachedIn(tree());
      attached.capability.record("bounded", { deep: nested(16) });
      const status = await attached.freeze(500);
      expect({
        complete: get(status, "countsComplete"),
        truncated: get(status, "truncatedRecords"),
      }).toEqual({ complete: true, truncated: 1 });
    },
    timeout,
  );
});
