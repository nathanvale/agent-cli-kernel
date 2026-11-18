import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanTrees,
  get,
  limits,
  lines,
  observe,
  open,
  run,
  start,
  tree,
  waitForFile,
} from "./harness.ts";
import type { DirectoryEntry, Run, Tree } from "./harness.ts";
import {
  expectAvailable,
  expectUnavailable,
  expectSuccess,
  expectTwinEqual,
  machine,
  statusOf,
} from "./support.ts";

afterAll(cleanTrees);
const read = ["read", ...machine] as const;
const timeout = 120_000;
const day = 24 * 60 * 60 * 1000;

function status(result: Run) {
  const value = statusOf(result);
  if (get(value, "status") === "available") expectAvailable(value);
  else expectUnavailable(value, "status-invalid");
  return {
    sinkFailure: get(value, "sinkFailure"),
    dropped: Number(get(value, "droppedRecords")),
    unflushed: Number(get(value, "unflushedRecords")),
    truncated: Number(get(value, "truncatedRecords")),
    file: get(value, "file"),
    closed: get(value, "closed"),
    countsComplete: get(value, "countsComplete"),
  };
}

function logs(dir: string) {
  return observe(dir).files.filter((entry) => entry.name.endsWith(".jsonl"));
}

// Platform: Which log a file is, told by what no other file can be given: its name (the
// run identity) and its first record. An inode number is not such a mark:
// ext4 hands a freed inode number to the next file created, so a pruned
// log's number can come back on the new run's own log (the hosted Linux
// failure of D06.file-count-near-cap).
type Identity = { name: string; ino: number; first: string };

function identify(entry: DirectoryEntry): Identity {
  const [first = ""] = readFileSync(entry.path, "utf8").split("\n");
  return { name: entry.name, ino: entry.ino, first };
}

function expectRemoved(dir: string, removed: Identity | undefined) {
  if (!removed) throw new Error("no log to prove removed");
  const now = logs(dir).map(identify);
  expect(now.map((entry) => entry.name)).not.toContain(removed.name);
  expect(now.map((entry) => entry.first)).not.toContain(removed.first);
}

function expectKept(dir: string, kept: Identity | undefined) {
  if (!kept) throw new Error("no log to prove kept");
  expect(logs(dir).map(identify)).toContainEqual(kept);
}

const fullRun = { records: 64, size: 15_000, pace: true } as const;

const fixture = { capacityRetries: 0 };
async function closedLogs(
  where: Tree,
  count: number,
  script: Record<string, unknown>,
) {
  for (let attempts = 0; logs(where.dir).length < count; attempts += 1) {
    if (attempts > count * 3)
      throw new Error("Closed-log fixture never filled.");
    const result = await run({ argv: read, tree: where, script });
    expectSuccess(result);
    const failure = get(statusOf(result), "sinkFailure");
    if (failure === "capacity") fixture.capacityRetries += 1;
    else expect(failure).toBeNull();
  }
  return logs(where.dir).sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function age(path: string, days: number) {
  const when = new Date(Date.now() - days * day);
  utimesSync(path, when, when);
}

describe("D05 record and buffer limits", () => {
  test(
    "D05.record-over-64000-truncated: an oversize record is kept truncated, visibly, and counted",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 1, size: 70_000 },
      });
      expectSuccess(result);
      const counts = status(result);
      expect(counts.truncated).toBe(1);
      expect(counts.dropped).toBe(0);
      const [log] = logs(where.dir);
      if (!log) throw new Error("no log");
      const text = readFileSync(log.path, "utf8");
      const [line] = text.split("\n");
      expect(Buffer.byteLength(`${line ?? ""}\n`)).toBeLessThanOrEqual(
        limits.recordBytes,
      );
      expect(text).toContain("[truncated");
      expect(lines(log.path)).toHaveLength(1);
    },
    timeout,
  );

  test(
    "D05.buffer-256-records: records beyond 256 queued are rejected before the buffer and counted",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        fault: "write-stalls",
        script: { records: 300 },
      });
      expectSuccess(result);
      const counts = status(result);
      expect(counts.unflushed).toBe(limits.bufferRecords);
      expect(counts.dropped).toBe(300 - limits.bufferRecords);
    },
    timeout,
  );

  test(
    "D05.buffer-1000000-bytes: buffered bytes stay within 1,000,000 including overhead",
    async () => {
      const probe = tree();
      expectSuccess(
        await run({
          argv: read,
          tree: probe,
          script: { records: 1, size: 16 },
        }),
      );
      const [probed] = observe(probe.dir).files;
      if (!probed) throw new Error("no probe log");
      const records = 250;
      const target = 3_970;
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        fault: "write-stalls",
        script: { records, size: target - (probed.size - 16) },
      });
      expectSuccess(result);
      const counts = status(result);
      expect(records * (target + 8)).toBeLessThanOrEqual(limits.bufferBytes);
      expect(counts.sinkFailure).toBe("flush-timeout");
      expect(counts.unflushed).toBeLessThan(records);
      expect(counts.unflushed * target).toBeLessThanOrEqual(limits.bufferBytes);
      expect(counts.unflushed + counts.dropped).toBe(records);
    },
    timeout,
  );

  test(
    "D05.over-depth-payload-marker: over-depth facts carry a visible marker",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 1, depth: 40 },
      });
      expectSuccess(result);
      expect(status(result).truncated).toBe(1);
      const [log] = logs(where.dir);
      expect(log ? readFileSync(log.path, "utf8") : "").toContain(
        "[truncated: depth]",
      );
    },
    timeout,
  );

  test(
    "D05.oversized-payload-marker: facts with too many entries carry a visible marker",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 1, keys: 1_500 },
      });
      expectSuccess(result);
      expect(status(result).truncated).toBe(1);
      const [log] = logs(where.dir);
      const [entry] = log ? lines(log.path) : [];
      expect(get(entry, "facts", "wide", "[truncated]")).toBe("500 more keys");
    },
    timeout,
  );
});

describe("D06 per-run and aggregate allocation", () => {
  test(
    "D06.per-run-cap: one run never writes more than 1,000,000 bytes and discloses the rest",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 100, size: 15_000, pace: true },
      });
      expectSuccess(result);
      const [log] = logs(where.dir);
      if (!log) throw new Error("no log");
      expect(log.size).toBeLessThanOrEqual(limits.perRunBytes);
      const counts = status(result);
      expect(counts.sinkFailure).toBe("capacity");
      expect(counts.unflushed).toBe(0);
      expect(lines(log.path).length + counts.dropped).toBe(100);
      await expectTwinEqual(result, { argv: read, script: { records: 100 } });
    },
    timeout,
  );

  test(
    "D06.aggregate-near-cap: active and closed logs together stay within 10,000,000 bytes",
    async () => {
      const where = tree();
      const before = (await closedLogs(where, 10, fullRun)).map(identify);
      expect(observe(where.dir).fileBytes).toBeGreaterThan(9_000_000);
      const result = await run({ argv: read, tree: where, script: fullRun });
      expectSuccess(result);
      const after = observe(where.dir);
      expect(after.fileBytes).toBeLessThanOrEqual(limits.aggregateBytes);
      expect(after.files.length).toBeLessThanOrEqual(limits.files);
      expectRemoved(where.dir, before[0]);
      expect(status(result).sinkFailure).toBeNull();
    },
    timeout,
  );

  test(
    "D06.file-count-near-cap: no more than 50 files, the oldest closed log making room",
    async () => {
      const where = tree();
      const before = (
        await closedLogs(where, limits.files, { records: 1 })
      ).map(identify);
      expect(before).toHaveLength(limits.files);
      const result = await run({ argv: read, tree: where });
      expectSuccess(result);
      const after = observe(where.dir);
      expect(after.files.length).toBeLessThanOrEqual(limits.files);
      expectRemoved(where.dir, before[0]);
      expect(status(result).sinkFailure).toBeNull();
      process.stderr.write(
        `D06.file-count-near-cap fixture: ${fixture.capacityRetries} capacity retries so far\n`,
      );
    },
    timeout,
  );

  test(
    "D06.no-safe-capacity: with no prunable room diagnostics stop and disclose; the result is unchanged",
    async () => {
      const where = tree();
      mkdirSync(where.dir, { recursive: true, mode: 0o700 });
      for (const path of [where.state, join(where.state, "dxs"), where.dir])
        chmodSync(path, 0o700);
      for (let index = 0; index < 10; index += 1)
        writeFileSync(join(where.dir, `ambiguous-${index}.jsonl`), "x", {
          mode: 0o600,
        });
      const result = await run({ argv: read, tree: where });
      expectSuccess(result);
      const counts = status(result);
      expect(counts.sinkFailure).toBe("capacity");
      expect(counts.file).toBeNull();
      expect(logs(where.dir)).toHaveLength(10);
      await expectTwinEqual(result, { argv: read });
    },
    timeout,
  );
});

describe("D07 pruning eligibility", () => {
  test(
    "D07.old-closed-pruned-first: a closed log older than seven days goes even when room exists",
    async () => {
      const where = tree();
      const [first, second, third] = await closedLogs(where, 3, { records: 1 });
      if (!first || !second || !third) throw new Error("setup");
      age(second.path, limits.pruneClosedOlderThanDays + 1);
      age(first.path, limits.pruneClosedOlderThanDays - 1);
      const [kept, pruned, newest] = [first, second, third].map(identify);
      expectSuccess(await run({ argv: read, tree: where }));
      expectRemoved(where.dir, pruned);
      for (const survivor of [kept, newest]) expectKept(where.dir, survivor);
    },
    timeout,
  );

  test(
    "D07.oldest-closed-pruned-for-room: only the oldest confirmed-closed log goes when room is needed",
    async () => {
      const where = tree();
      const before = (await closedLogs(where, 10, fullRun)).map(identify);
      expectSuccess(await run({ argv: read, tree: where }));
      expectRemoved(where.dir, before[0]);
      for (const survivor of before.slice(1)) expectKept(where.dir, survivor);
    },
    timeout,
  );

  test(
    "D07.active-survives: a held run's log is never pruned, however old it looks",
    async () => {
      const where = tree();
      const before = new Set(
        (await closedLogs(where, 9, fullRun)).map((entry) => entry.name),
      );
      const ready = join(where.root, "ready");
      const go = join(where.root, "go");
      const held = start({
        argv: read,
        tree: where,
        script: { records: 2, hold: { after: 1, ready, go } },
      });
      await waitForFile(ready);
      let active = logs(where.dir).find((entry) => !before.has(entry.name));
      const until = performance.now() + 30_000;
      while (!active) {
        if (performance.now() > until)
          throw new Error("No active log appeared.");
        await Bun.sleep(2);
        active = logs(where.dir).find((entry) => !before.has(entry.name));
      }
      age(active.path, 30);
      expectSuccess(await run({ argv: read, tree: where, script: fullRun }));
      expect(
        logs(where.dir).map((entry) => ({ name: entry.name, ino: entry.ino })),
      ).toContainEqual({ name: active.name, ino: active.ino });
      open(go);
      expectSuccess(await held.finished);
      expect(observe(where.dir).fileBytes).toBeLessThanOrEqual(
        limits.aggregateBytes,
      );
    },
    timeout,
  );

  test(
    "D07.timed-out-survives: a timed-out sink's log is never pruned by age",
    async () => {
      const where = tree();
      const timedOut = await run({
        argv: read,
        tree: where,
        fault: "write-stalls-after:1",
        script: { records: 3 },
      });
      expectSuccess(timedOut);
      expect(get(statusOf(timedOut), "sinkFailure")).toBe("flush-timeout");
      const [log] = logs(where.dir);
      if (!log) throw new Error("no log");
      age(log.path, 30);
      const timedOutLog = identify(log);
      await closedLogs(where, 9, fullRun);
      expectSuccess(await run({ argv: read, tree: where, script: fullRun }));
      expectKept(where.dir, timedOutLog);
    },
    timeout,
  );

  test(
    "D07.ambiguous-survives: files not confirmed closed are never pruned by age",
    async () => {
      const where = tree();
      await closedLogs(where, 1, { records: 1 });
      const stray = join(where.dir, "stray.jsonl");
      const notes = join(where.dir, "notes.txt");
      writeFileSync(stray, "{}\n", { mode: 0o600 });
      writeFileSync(notes, "notes\n", { mode: 0o600 });
      age(stray, 30);
      age(notes, 30);
      await closedLogs(where, 7, fullRun);
      expectSuccess(await run({ argv: read, tree: where, script: fullRun }));
      const names = observe(where.dir).files.map((entry) => entry.name);
      expect(names).toContain("stray.jsonl");
      expect(names).toContain("notes.txt");
    },
    timeout,
  );
});

type Concurrent = {
  readonly results: readonly Run[];
  readonly samples: readonly { files: number; bytes: number }[];
};
let concurrent: Promise<Concurrent> | undefined;
function concurrentPruners(): Promise<Concurrent> {
  concurrent ??= (async () => {
    const where = tree();
    await closedLogs(where, 9, fullRun);
    const go = join(where.root, "go");
    const runs = Array.from({ length: 4 }, (_, index) => {
      const ready = join(where.root, `ready-${index}`);
      return {
        ready,
        launched: start({
          argv: read,
          tree: where,
          script: { ...fullRun, hold: { after: 0, ready, go } },
        }),
      };
    });
    for (const entry of runs) await waitForFile(entry.ready);
    const samples: { files: number; bytes: number }[] = [];
    let finished = false;
    const done = Promise.all(runs.map((entry) => entry.launched.finished)).then(
      (results) => {
        finished = true;
        return results;
      },
    );
    open(go);
    while (!finished) {
      const view = observe(where.dir);
      samples.push({ files: view.files.length, bytes: view.fileBytes });
      await Bun.sleep(1);
    }
    const view = observe(where.dir);
    samples.push({ files: view.files.length, bytes: view.fileBytes });
    return { results: await done, samples };
  })();
  return concurrent;
}

describe("D08 concurrent pruners", () => {
  test(
    "D08.concurrent-pruners-near-full: concurrent runs complete with their twin results",
    async () => {
      const { results } = await concurrentPruners();
      for (const result of results) {
        expectSuccess(result);
        await expectTwinEqual(result, { argv: read, script: fullRun });
        expectAvailable(statusOf(result));
        const failure = get(statusOf(result), "sinkFailure");
        expect(failure === null || failure === "capacity").toBe(true);
      }
    },
    timeout,
  );

  test(
    "D08.sampled-caps-held: every sample and the end state stay within both caps",
    async () => {
      const { samples } = await concurrentPruners();
      expect(samples.length).toBeGreaterThan(1);
      for (const sample of samples) {
        expect(sample.bytes).toBeLessThanOrEqual(limits.aggregateBytes);
        expect(sample.files).toBeLessThanOrEqual(limits.files);
      }
    },
    timeout,
  );
});
