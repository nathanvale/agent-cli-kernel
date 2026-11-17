import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanTrees, get, lines, observe, run, tree } from "./harness.ts";
import type { Run, Tree } from "./harness.ts";
import {
  expectAvailable,
  expectSuccess,
  expectTwinEqual,
  machine,
  statusOf,
} from "./support.ts";

afterAll(cleanTrees);
const timeout = 60_000;

function marker(source: string): string {
  return `T5SYNTHMARKER-${source}-${crypto.randomUUID()}`;
}

function everyFile(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk(root);
  return found;
}

async function secretAbsentAfterPositive(
  result: Run,
  where: Tree,
  secret: string,
  launch: {
    readonly argv: readonly string[];
    readonly script: Record<string, unknown>;
    readonly env?: Record<string, string>;
  },
  allowed: readonly string[] = [],
) {
  expectSuccess(result);
  expect(get(result.envelope, "result", "data")).toEqual({
    records: launch.script.records,
  });
  await expectTwinEqual(result, launch);
  const status = statusOf(result);
  expectAvailable(status);
  expect(get(status, "sinkFailure")).toBeNull();
  const [log] = observe(where.dir).files;
  if (!log) throw new Error("no log to inspect");
  expect(lines(log.path)).toHaveLength(Number(launch.script.records));
  expect(result.stdout).not.toContain(secret);
  expect(result.stderr).not.toContain(secret);
  for (const path of everyFile(where.root).filter(
    (path) => !allowed.includes(path),
  ))
    expect(readFileSync(path, "utf8")).not.toContain(secret);
  expect(readFileSync(log.path, "utf8")).toContain("[REDACTED]");
  return log;
}

describe("D15 secret redaction after a positive outcome", () => {
  test(
    "D15.argv-marker: a secret option value never reaches output or the log",
    async () => {
      const where = tree();
      const secret = marker("argv");
      const launch = {
        argv: ["read", "--token", secret, ...machine],
        script: { records: 3, secretFacts: true },
      };
      const result = await run({ ...launch, tree: where });
      const log = await secretAbsentAfterPositive(
        result,
        where,
        secret,
        launch,
      );
      expect(readFileSync(log.path, "utf8")).toContain(
        "the value [REDACTED] appears in prose",
      );
    },
    timeout,
  );

  test(
    "D15.file-marker: a secret file's contents never reach output or the log",
    async () => {
      const where = tree();
      const secret = marker("file");
      const input = join(where.root, "token.txt");
      writeFileSync(input, `${secret}\n`, { mode: 0o600 });
      const launch = {
        argv: ["read", "--token-file", input, ...machine],
        script: { records: 2, secretFacts: true },
      };
      const result = await run({ ...launch, tree: where });
      await secretAbsentAfterPositive(result, where, secret, launch, [input]);
    },
    timeout,
  );

  test(
    "D15.environment-marker: a secret environment value never reaches output or the log",
    async () => {
      const where = tree();
      const secret = marker("env");
      const launch = {
        argv: ["read", ...machine],
        script: { records: 2, secretFacts: true },
        env: { DXS_TOKEN: secret },
      };
      const result = await run({ ...launch, tree: where });
      await secretAbsentAfterPositive(result, where, secret, launch);
    },
    timeout,
  );

  test(
    "D15.crash-cannot-pass: a crashing run never passes the secrecy check",
    async () => {
      const where = tree();
      const secret = marker("crash");
      const launch = {
        argv: ["read", "--token", secret, ...machine],
        script: { records: 2, secretFacts: true, crash: true },
      };
      const result = await run({ ...launch, tree: where });
      expect(result.stdout).toBe("");
      let passed = true;
      try {
        await secretAbsentAfterPositive(result, where, secret, launch);
      } catch {
        passed = false;
      }
      expect(passed).toBe(false);
    },
    timeout,
  );

  test(
    "D15.coverage-limits-reported: forms outside the named coverage are reported, not passed",
    async () => {
      const where = tree();
      const secret = marker("limits");
      const launch = {
        argv: ["read", "--token", secret, ...machine],
        script: { records: 1, secretFacts: true, limitForms: true },
      };
      const result = await run({ ...launch, tree: where });
      const [log] = observe(where.dir).files;
      expectSuccess(result);
      if (!log) throw new Error("no log");
      const text = readFileSync(log.path, "utf8");
      expect(text).not.toContain(secret);
      expect(text).toContain(Buffer.from(secret).toString("base64"));
      expect(text).toContain(secret.slice(6));
    },
    timeout,
  );
});

describe("D16 record context", () => {
  test(
    "D16.identity-and-command: every record carries the envelope's run identity and the command",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", ...machine],
        tree: where,
        script: { records: 5 },
      });
      expectSuccess(result);
      const runId = get(result.envelope, "result", "runId");
      const [log] = observe(where.dir).files;
      for (const entry of lines(log?.path ?? "")) {
        expect(get(entry, "runId")).toBe(runId);
        expect(get(entry, "command")).toBe("dxs.read");
      }
    },
    timeout,
  );

  test(
    "D16.sequence-across-async: sequence numbers strictly increase across interleaved async work",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", ...machine],
        tree: where,
        script: { records: 40, tasks: 4 },
      });
      expectSuccess(result);
      const [log] = observe(where.dir).files;
      const entries = lines(log?.path ?? "");
      expect(entries).toHaveLength(40);
      const tasks = new Set(
        entries.map((entry) => get(entry, "facts", "task")),
      );
      expect(tasks.size).toBe(4);
      const sequence = entries.map((entry) => Number(get(entry, "seq")));
      expect(sequence).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
      const runIds = new Set(entries.map((entry) => get(entry, "runId")));
      expect([...runIds]).toEqual([get(result.envelope, "result", "runId")]);
    },
    timeout,
  );

  test(
    "D16.duration-present: every record carries a non-decreasing elapsed duration",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", ...machine],
        tree: where,
        script: { records: 5, pace: true },
      });
      expectSuccess(result);
      const [log] = observe(where.dir).files;
      const elapsed = lines(log?.path ?? "").map((entry) =>
        get(entry, "elapsedMilliseconds"),
      );
      expect(elapsed).toHaveLength(5);
      let previous = 0;
      for (const value of elapsed) {
        if (typeof value !== "number") throw new Error("no duration");
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    },
    timeout,
  );

  test(
    "D16.self-reporting-bounded: failures inside the logger stay in memory, counted, never written",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", ...machine],
        tree: where,
        script: { records: 2_000, hostile: true },
      });
      expectSuccess(result);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      const status = statusOf(result);
      expectAvailable(status);
      expect(get(status, "countsComplete")).toBe(false);
      expect(get(status, "droppedRecords")).toBe(2_000);
      expect(observe(where.state).exists).toBe(true);
      for (const entry of observe(where.dir).files) expect(entry.size).toBe(0);
    },
    timeout,
  );
});
