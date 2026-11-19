import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canon,
  cleanTrees,
  get,
  limits,
  lines,
  observe,
  run,
  tree,
} from "./harness.ts";
import {
  expectAvailable,
  expectSuccess,
  machine,
  statusOf,
} from "./support.ts";

afterAll(cleanTrees);
const timeout = 120_000;
const entry = join(import.meta.dir, "fixtures/log-lines-cli.ts");

const sent = [
  { name: "unlevelled", level: "info" },
  { name: "trace", level: "trace" },
  { name: "debug", level: "debug" },
  { name: "info", level: "info" },
  { name: "warning", level: "warning" },
  { name: "error", level: "error" },
  { name: "fatal", level: "fatal" },
];
const sentLevels = sent.map((line) => line.level);
const oversizedLine = sent.findIndex((line) => line.name === "error");
const unlistedLevels = ["warn", "constructor", 3];

async function launched(script: Readonly<Record<string, unknown>>) {
  const where = tree();
  const secret = `LOGLINEMARKER-${crypto.randomUUID()}`;
  const result = await run({
    argv: ["read", "--token", secret, ...machine],
    tree: where,
    entry,
    script,
  });
  expectSuccess(result);
  expect(get(result.envelope, "result", "data")).toEqual({ logged: true });
  const status = statusOf(result);
  expectAvailable(status);
  return { result, status, secret, files: observe(where.dir).files };
}

async function logged(script: Readonly<Record<string, unknown>> = {}) {
  const run = await launched(script);
  expect(run.files).toHaveLength(1);
  const [log] = run.files;
  if (!log) throw new Error("The run wrote no diagnostics file.");
  return {
    ...run,
    text: readFileSync(log.path, "utf8"),
    written: lines(log.path),
  };
}

function column(written: readonly unknown[], ...path: readonly string[]) {
  return written.map((line) => get(line, ...path));
}

describe("a host logger's lines sent through diagnostics.record", () => {
  test(
    "a log line lands in the run's file under the level it was sent with",
    async () => {
      const { written, status } = await logged();
      expect(column(written, "level")).toEqual(sentLevels);
      expect(column(written, "event")).toEqual(sent.map(() => "log"));
      expect(column(written, "seq")).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect({
        failure: get(status, "sinkFailure"),
        dropped: get(status, "droppedRecords"),
        truncated: get(status, "truncatedRecords"),
        unflushed: get(status, "unflushedRecords"),
      }).toEqual({ failure: null, dropped: 0, truncated: 0, unflushed: 0 });
    },
    timeout,
  );

  test(
    "a log line's declared secret and password field are redacted at every level",
    async () => {
      const { written, text, secret } = await logged();
      expect(column(written, "facts", "message")).toEqual(
        sent.map((line) => `${line.name} line for [REDACTED]`),
      );
      expect(column(written, "facts", "annotations", "password")).toEqual(
        sent.map(() => "[REDACTED]"),
      );
      expect(text).not.toContain(secret);
      expect(text).not.toContain("log-line-password");
    },
    timeout,
  );

  test(
    "an oversized log line is cut at the record cap and keeps its level",
    async () => {
      const { written, text, status } = await logged({ oversize: 70_000 });
      expect(written).toHaveLength(sent.length);
      const cut = text.split("\n")[oversizedLine] ?? "";
      expect(cut.length).toBeGreaterThan(limits.recordBytes / 2);
      expect(Buffer.byteLength(cut) + 1).toBeLessThanOrEqual(
        limits.recordBytes,
      );
      expect(get(written[oversizedLine], "level")).toBe("error");
      expect(get(written[oversizedLine], "truncated")).toBe(
        "[truncated: record exceeded 64000 bytes]",
      );
      expect({
        dropped: get(status, "droppedRecords"),
        truncated: get(status, "truncatedRecords"),
      }).toEqual({ dropped: 0, truncated: 1 });
    },
    timeout,
  );

  test(
    "a burst of levelled lines past the 256 record buffer is dropped and counted",
    async () => {
      const { written, status } = await logged({ burst: 300 });
      expect(written).toHaveLength(limits.bufferRecords);
      expect(new Set(column(written, "level"))).toEqual(new Set(["warning"]));
      expect({
        failure: get(status, "sinkFailure"),
        dropped: get(status, "droppedRecords"),
        unflushed: get(status, "unflushedRecords"),
      }).toEqual({
        failure: null,
        dropped: 300 - limits.bufferRecords,
        unflushed: 0,
      });
    },
    timeout,
  );

  test(
    "levelled lines past the 1,000,000 byte run cap stop being written and are counted",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", ...machine],
        tree: where,
        script: { records: 100, size: 15_000, pace: true, level: "warning" },
      });
      expectSuccess(result);
      const status = statusOf(result);
      expectAvailable(status);
      const [log] = observe(where.dir).files;
      if (!log) throw new Error("The run wrote no diagnostics file.");
      const written = lines(log.path);
      expect(log.size).toBeLessThanOrEqual(limits.perRunBytes);
      expect(log.size).toBeGreaterThan(limits.perRunBytes - 2 * 15_000);
      expect(new Set(column(written, "level"))).toEqual(new Set(["warning"]));
      expect(get(status, "sinkFailure")).toBe("capacity");
      expect(get(status, "unflushedRecords")).toBe(0);
      expect(written.length + Number(get(status, "droppedRecords"))).toBe(100);
    },
    timeout,
  );

  test(
    "a record sent without a level is still written at info",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", ...machine],
        tree: where,
        script: { records: 3 },
      });
      expectSuccess(result);
      const [log] = observe(where.dir).files;
      if (!log) throw new Error("The run wrote no diagnostics file.");
      expect(column(lines(log.path), "level")).toEqual([
        "info",
        "info",
        "info",
      ]);
    },
    timeout,
  );

  test(
    "a level outside the six is dropped and counted, and the result is unchanged",
    async () => {
      const listedOnly = await logged();
      for (const unlisted of unlistedLevels) {
        const { written, text, status, result } = await logged({ unlisted });
        expect(column(written, "level")).toEqual(sentLevels);
        expect(column(written, "seq")).toEqual([1, 2, 3, 4, 6, 7, 8]);
        expect(text).not.toContain("unlisted line");
        expect(get(status, "droppedRecords")).toBe(1);
        expect(canon(result.envelope)).toBe(canon(listedOnly.result.envelope));
      }
    },
    timeout,
  );

  test(
    "a run whose only record has a level outside the six opens no file",
    async () => {
      for (const unlisted of unlistedLevels) {
        const { status, files } = await launched({ unlisted, alone: true });
        expect(files).toEqual([]);
        expect({
          file: get(status, "file"),
          failure: get(status, "sinkFailure"),
          dropped: get(status, "droppedRecords"),
        }).toEqual({ file: null, failure: null, dropped: 1 });
      }
    },
    timeout,
  );
});
