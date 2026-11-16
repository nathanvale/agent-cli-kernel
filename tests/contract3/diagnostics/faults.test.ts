// D10 to D12: sink faults and the stuck flush, variant validation, and
// accounting semantics. Faults come from the labelled fault adapter; the
// domain result is judged against the diagnostics-disabled twin and the
// status shape by the kernel's own validator.
import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, statSync } from "node:fs";
import { createDiagnostics } from "../../../starters/contract3/src/addons/diagnostics/run.ts";
import { nodeIo } from "../../../starters/contract3/src/addons/diagnostics/io.ts";
import type { DiagnosticsIo } from "../../../starters/contract3/src/addons/diagnostics/io.ts";
import {
  cleanTrees,
  get,
  lines,
  observe,
  run,
  tree,
  waitForLog,
} from "./harness.ts";
import type { Run } from "./harness.ts";
import {
  expectStatusShape,
  expectSuccess,
  expectTwinEqual,
  machine,
  statusOf,
} from "./support.ts";

afterAll(cleanTrees);
const read = ["read", ...machine] as const;
const timeout = 60_000;

function status(result: Run) {
  const value = statusOf(result);
  expectStatusShape(value);
  return value;
}

function onlyLog(dir: string) {
  const [log] = observe(dir).files.filter((entry) =>
    entry.name.endsWith(".jsonl"),
  );
  if (!log) throw new Error("no log");
  return log;
}

async function faulted(
  fault: string,
  script: Record<string, unknown> = { records: 3 },
) {
  const where = tree();
  const result = await run({ argv: read, tree: where, fault, script });
  expectSuccess(result);
  await expectTwinEqual(result, { argv: read, script });
  return { where, result, status: status(result) };
}

describe("D10 sink faults and the stuck flush", () => {
  test(
    "D10.throwing-write: a write fault is disclosed and changes nothing else",
    async () => {
      const { status: value } = await faulted("write-throws");
      expect(get(value, "status")).toBe("available");
      expect(get(value, "sinkFailure")).toBe("write");
      expect(get(value, "unflushedRecords")).toBe(3);
      expect(get(value, "droppedRecords")).toBe(0);
    },
    timeout,
  );

  test(
    "D10.close-failure: a close fault is disclosed with closed false",
    async () => {
      const { where, status: value } = await faulted("close-throws");
      expect(get(value, "sinkFailure")).toBe("close");
      expect(get(value, "closed")).toBe(false);
      expect(get(value, "unflushedRecords")).toBe(0);
      expect(lines(onlyLog(where.dir).path)).toHaveLength(3);
    },
    timeout,
  );

  test(
    "D10.stuck-flush-bound: finalisation spends at most 500 ms on a stuck flush",
    async () => {
      const script = { records: 5 };
      const intact = await run({ argv: read, tree: tree(), script });
      expectSuccess(intact);
      const { result, status: value } = await faulted("write-stalls", script);
      const extra = result.elapsedMilliseconds - intact.elapsedMilliseconds;
      // The flush bound is 500 ms; 150 ms of tolerance for process noise on a
      // loaded host. The lower bound shows the bounded wait actually ran.
      expect(extra).toBeLessThanOrEqual(500 + 150);
      expect(extra).toBeGreaterThanOrEqual(300);
      expect(get(value, "sinkFailure")).toBe("flush-timeout");
      expect(get(value, "closed")).toBe(false);
      expect(get(value, "unflushedRecords")).toBe(5);
    },
    timeout,
  );

  test(
    "D10.late-completion-ignored: a write that completes after the freeze changes nothing and writes nothing",
    async () => {
      // Component support: a real process exits right after its envelope, so
      // the late completion is driven in process with a held write.
      const where = tree();
      const pending: ((count: number) => void)[] = [];
      let writes = 0;
      let closes = 0;
      const io: DiagnosticsIo = {
        open: nodeIo.open,
        size: nodeIo.size,
        write: (_descriptor, bytes) => {
          writes += 1;
          return new Promise((resolve) =>
            pending.push(() => resolve(bytes.length)),
          );
        },
        close: (descriptor) => {
          closes += 1;
          nodeIo.close(descriptor);
        },
      };
      const attached = createDiagnostics(
        { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
        io,
      ).attach({
        runId: crypto.randomUUID(),
        commandIdentity: "dxs.read",
        summary: "Late completion.",
        signal: new AbortController().signal,
      });
      attached.capability.record("first", { index: 0 });
      attached.capability.record("second", { index: 1 });
      await waitForLog(where.dir);
      const frozen = await attached.freeze(500);
      const snapshot = JSON.stringify(frozen);
      const before = statSync(onlyLog(where.dir).path);
      for (const complete of pending.splice(0)) complete(0);
      for (const complete of pending.splice(0)) complete(1);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(JSON.stringify(await attached.freeze(500))).toBe(snapshot);
      expect(get(frozen, "sinkFailure")).toBe("flush-timeout");
      expect(writes).toBe(1);
      expect(closes).toBe(0);
      const after = statSync(onlyLog(where.dir).path);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    },
    timeout,
  );

  test(
    "D10.first-fault-in-time: the first fault is reported and later loss still counted",
    async () => {
      // The first write fails; records paced after it are later loss; the
      // close fault comes last.
      const { status: value } = await faulted("write-throws,close-throws", {
        records: 20,
        pace: true,
      });
      expect(get(value, "sinkFailure")).toBe("write");
      expect(get(value, "closed")).toBe(false);
      const dropped = Number(get(value, "droppedRecords"));
      const unflushed = Number(get(value, "unflushedRecords"));
      expect(dropped).toBeGreaterThan(0);
      expect(unflushed).toBeGreaterThan(0);
      expect(dropped + unflushed).toBe(20);
    },
    timeout,
  );
});

describe("D11 variant validation", () => {
  test(
    "D11.status-invalid-keeps-file: accounting that fails its invariants keeps the verified path",
    async () => {
      const { where, status: value } = await faulted("write-lies");
      expect(get(value, "status")).toBe("unavailable");
      expect(get(value, "reason")).toBe("status-invalid");
      const file = get(value, "trusted", "file");
      if (typeof file !== "string") throw new Error("trusted file missing");
      expect(lstatSync(file).ino).toBe(onlyLog(where.dir).ino);
      expect(get(value, "trusted", "countsComplete")).toBe(false);
    },
    timeout,
  );

  test(
    "D11.status-unavailable: unobtainable accounting is status-unavailable and claims no sink failure",
    async () => {
      const { where, status: value } = await faulted("size-throws");
      expect(get(value, "status")).toBe("unavailable");
      expect(get(value, "reason")).toBe("status-unavailable");
      expect(get(value, "trusted", "sinkFailure")).toBeNull();
      expect(get(value, "trusted", "file")).toBe(onlyLog(where.dir).path);
    },
    timeout,
  );

  test(
    "D11.unknown-facts-omitted: an unknown fact is absent, never defaulted",
    async () => {
      const { status: value } = await faulted("size-throws");
      const trusted = get(value, "trusted");
      if (typeof trusted !== "object" || trusted === null)
        throw new Error("no trusted");
      // How many admitted records reached the file is unknown here.
      expect(Object.keys(trusted).sort()).toEqual([
        "closed",
        "countsComplete",
        "droppedRecords",
        "file",
        "sinkFailure",
        "truncatedRecords",
      ]);
      expect(get(trusted, "countsComplete")).toBe(false);
    },
    timeout,
  );
});

describe("D12 accounting semantics", () => {
  test(
    "D12.records-not-bytes: counters count records",
    async () => {
      const { status: value } = await faulted("write-stalls", {
        records: 10,
        size: 30_000,
      });
      expect(get(value, "unflushedRecords")).toBe(10);
      expect(get(value, "droppedRecords")).toBe(0);
    },
    timeout,
  );

  test(
    "D12.dropped-unflushed-disjoint: each record is counted once, dropped or unflushed",
    async () => {
      const { status: value } = await faulted("write-stalls", { records: 300 });
      const dropped = Number(get(value, "droppedRecords"));
      const unflushed = Number(get(value, "unflushedRecords"));
      expect(dropped).toBeGreaterThan(0);
      expect(unflushed).toBeGreaterThan(0);
      expect(dropped + unflushed).toBe(300);
    },
    timeout,
  );

  test(
    "D12.truncated-may-overlap-unflushed: a truncated record can also be unflushed",
    async () => {
      const { status: value } = await faulted("write-stalls", {
        records: 2,
        size: 70_000,
      });
      expect(get(value, "truncatedRecords")).toBe(2);
      expect(get(value, "unflushedRecords")).toBe(2);
    },
    timeout,
  );

  test(
    "D12.counts-complete-only-when-exact: completeness is claimed only with exact accounting",
    async () => {
      const where = tree();
      const intact = await run({
        argv: read,
        tree: where,
        script: { records: 4 },
      });
      expectSuccess(intact);
      const exact = status(intact);
      expect(get(exact, "countsComplete")).toBe(true);
      expect(get(exact, "droppedRecords")).toBe(0);
      expect(get(exact, "unflushedRecords")).toBe(0);
      expect(lines(onlyLog(where.dir).path)).toHaveLength(4);
      const { status: lying } = await faulted("write-lies");
      expect(get(lying, "trusted", "countsComplete")).toBe(false);
      const { status: hostile } = await faulted("", {
        records: 3,
        hostile: true,
      });
      expect(get(hostile, "countsComplete")).toBe(false);
    },
    timeout,
  );

  test(
    "D12.closed-only-when-confirmed: closed is true only after a confirmed close",
    async () => {
      const intact = await run({ argv: read, tree: tree() });
      expectSuccess(intact);
      expect(get(status(intact), "closed")).toBe(true);
      const { status: failedClose } = await faulted("close-throws");
      expect(get(failedClose, "closed")).toBe(false);
      const { status: stuck } = await faulted("write-stalls");
      expect(get(stuck, "closed")).toBe(false);
    },
    timeout,
  );
});
