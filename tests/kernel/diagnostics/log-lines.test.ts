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
import { expectAvailable, machine, statusOf } from "./support.ts";

afterAll(cleanTrees);
const timeout = 60_000;
const entry = join(import.meta.dir, "fixtures/log-lines-cli.ts");

const sentNames = [
  "unlevelled",
  "trace",
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
];
const writtenLevels = [
  "info",
  "trace",
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
];

async function logged(script: Readonly<Record<string, unknown>> = {}) {
  const where = tree();
  const secret = `LOGLINEMARKER-${crypto.randomUUID()}`;
  const result = await run({
    argv: ["read", "--token", secret, ...machine],
    tree: where,
    entry,
    script,
  });
  expect({
    exit: result.exit,
    signal: result.signal,
    stderr: result.stderr,
    data: get(result.envelope, "result", "data"),
  }).toEqual({ exit: 0, signal: null, stderr: "", data: { lines: 7 } });
  const status = statusOf(result);
  expectAvailable(status);
  expect(get(status, "sinkFailure")).toBeNull();
  const logs = observe(where.dir).files;
  expect(logs).toHaveLength(1);
  const [log] = logs;
  if (!log) throw new Error("The run wrote no diagnostics file.");
  return {
    result,
    status,
    secret,
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
      expect(column(written, "level")).toEqual(writtenLevels);
      expect(column(written, "event")).toEqual([
        "log",
        "log",
        "log",
        "log",
        "log",
        "log",
        "log",
      ]);
      expect(column(written, "seq")).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect({
        dropped: get(status, "droppedRecords"),
        truncated: get(status, "truncatedRecords"),
        unflushed: get(status, "unflushedRecords"),
      }).toEqual({ dropped: 0, truncated: 0, unflushed: 0 });
    },
    timeout,
  );

  test(
    "a log line's declared secret and password field are redacted at every level",
    async () => {
      const { written, text, secret, result } = await logged();
      expect(column(written, "level")).toEqual(writtenLevels);
      expect(column(written, "facts", "message")).toEqual(
        sentNames.map((name) => `${name} line for [REDACTED]`),
      );
      expect(column(written, "facts", "annotations", "password")).toEqual(
        sentNames.map(() => "[REDACTED]"),
      );
      expect(text).not.toContain(secret);
      expect(text).not.toContain("log-line-password");
      expect(result.stdout).not.toContain(secret);
    },
    timeout,
  );

  test(
    "an oversized log line is cut at the record cap and keeps its level",
    async () => {
      const { written, text, status } = await logged({ oversize: 70_000 });
      expect(column(written, "level")).toEqual(writtenLevels);
      const cut = text.split("\n")[5] ?? "";
      expect(cut.length).toBeGreaterThan(limits.recordBytes / 2);
      expect(Buffer.byteLength(cut) + 1).toBeLessThanOrEqual(
        limits.recordBytes,
      );
      expect(get(written[5], "truncated")).toBe(
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
    "a record sent without a level is still written at info",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", ...machine],
        tree: where,
        script: { records: 3 },
      });
      expect(result.exit).toBe(0);
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
      for (const unlisted of ["warn", "constructor", 3]) {
        const { written, text, status, result } = await logged({ unlisted });
        expect(column(written, "level")).toEqual(writtenLevels);
        expect(column(written, "seq")).toEqual([1, 2, 3, 4, 6, 7, 8]);
        expect(text).not.toContain("unlisted line");
        expect(get(status, "droppedRecords")).toBe(1);
        expect(canon(result.envelope)).toBe(canon(listedOnly.result.envelope));
      }
    },
    timeout,
  );
});
