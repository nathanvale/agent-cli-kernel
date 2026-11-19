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
import { nodeIo } from "../../../kernel/src/addons/diagnostics/io.ts";
import { createDiagnostics } from "../../../kernel/src/addons/diagnostics/run.ts";
import type { JsonValue } from "../../../kernel/src/kernel/index.ts";
import { cleanTrees, get, lines, observe, tree } from "./harness.ts";
import type { Tree } from "./harness.ts";

afterAll(cleanTrees);
beforeEach(resetSync);
afterEach(resetSync);
const timeout = 60_000;

function attachedIn(where: Tree) {
  const runId = crypto.randomUUID();
  const attached = createDiagnostics(
    { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
    nodeIo,
  ).attach({
    runId,
    commandIdentity: "dxs.read",
    summary: "In-process run.",
    signal: new AbortController().signal,
  });
  return { runId, attached };
}

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
    "two overlapping in-process runs each write only their own log lines",
    async () => {
      const where = tree();
      const first = attachedIn(where);
      const second = attachedIn(where);
      first.attached.capability.record("first-opened", { index: 1 });
      second.attached.capability.record("second-opened", { index: 1 });
      first.attached.capability.record("first-continued", { index: 2 });
      second.attached.capability.record("second-continued", { index: 2 });
      const [firstStatus, secondStatus] = await Promise.all([
        first.attached.freeze(500),
        second.attached.freeze(500),
      ]);
      expect(writtenBy(where, first.runId)).toEqual([
        { runId: first.runId, event: "first-opened" },
        { runId: first.runId, event: "first-continued" },
      ]);
      expect(writtenBy(where, second.runId)).toEqual([
        { runId: second.runId, event: "second-opened" },
        { runId: second.runId, event: "second-continued" },
      ]);
      for (const status of [firstStatus, secondStatus])
        expect({
          dropped: get(status, "droppedRecords"),
          complete: get(status, "countsComplete"),
          closed: get(status, "closed"),
        }).toEqual({ dropped: 0, complete: true, closed: true });
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
