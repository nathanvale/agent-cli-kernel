import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { LogRecord } from "@logtape/logtape";
import { nodeIo } from "../../../kernel/src/addons/diagnostics/io.ts";
import type { DiagnosticsIo } from "../../../kernel/src/addons/diagnostics/io.ts";
import {
  boundedValue,
  lineMaker,
} from "../../../kernel/src/addons/diagnostics/records.ts";
import { createDiagnostics } from "../../../kernel/src/addons/diagnostics/run.ts";
import type { JsonValue } from "../../../kernel/src/kernel/index.ts";
import { cleanTrees, get, lines, observe, tree } from "./harness.ts";

afterAll(cleanTrees);
const timeout = 60_000;
const traversalBudget = 16_000;

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function logRecord(facts: unknown): LogRecord {
  return {
    timestamp: Date.now(),
    level: "info",
    category: ["dxs", "diagnostics"],
    message: [],
    rawMessage: "",
    properties: {
      seq: 1,
      runId: "run-budget",
      commandIdentity: "dxs.read",
      elapsedMilliseconds: 0,
      event: "budget",
      facts,
    },
  };
}

function onlyLog(dir: string) {
  const [log] = observe(dir).files.filter((entry) =>
    entry.name.endsWith(".jsonl"),
  );
  if (!log) throw new Error("no log");
  return log;
}

async function flushMicrotasks() {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function heldWriteIo() {
  const writeEntered = deferred<void>();
  const releaseWrite = deferred<void>();
  const writeSettled = deferred<void>();
  let writes = 0;
  let closes = 0;
  let sizeCalls = 0;
  const io: DiagnosticsIo = {
    open: nodeIo.open,
    size: (descriptor) => {
      sizeCalls += 1;
      return nodeIo.size(descriptor);
    },
    write: async (descriptor, bytes) => {
      writes += 1;
      if (writes === 1) {
        writeEntered.resolve();
        await releaseWrite.promise;
      }
      const accepted = await nodeIo.write(descriptor, bytes);
      if (writes === 1) writeSettled.resolve();
      return accepted;
    },
    close: (descriptor) => {
      closes += 1;
      nodeIo.close(descriptor);
    },
  };
  return {
    io,
    writeEntered: writeEntered.promise,
    releaseWrite: releaseWrite.resolve,
    writeSettled: writeSettled.promise,
    counts: () => ({ writes, closes, sizeCalls }),
  };
}

function countingRow(length: number, onRead: () => void): unknown[] {
  const row: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1)
    Object.defineProperty(row, index, {
      enumerable: true,
      get() {
        onRead();
        return 0;
      },
    });
  return row;
}

describe("D18 diagnostics close on freeze/kill and traversal budget", () => {
  test(
    "D18.flush-timeout-closes-descriptor: a flush timeout closes the descriptor once after the held write settles, with no closed marker and unchanged status",
    async () => {
      const where = tree();
      const held = heldWriteIo();
      const attached = createDiagnostics(
        { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
        held.io,
      ).attach({
        runId: crypto.randomUUID(),
        commandIdentity: "dxs.read",
        summary: "Flush timeout close.",
        signal: new AbortController().signal,
      });
      attached.capability.record("first", { index: 0 });
      attached.capability.record("second", { index: 1 });
      await held.writeEntered;
      const frozen = await attached.freeze(50);
      const snapshot = JSON.stringify(frozen);
      expect(get(frozen, "sinkFailure")).toBe("flush-timeout");
      expect(get(frozen, "closed")).toBe(false);
      expect(held.counts().closes).toBe(0);
      held.releaseWrite();
      await held.writeSettled;
      await flushMicrotasks();
      expect(held.counts()).toEqual({ writes: 1, closes: 1, sizeCalls: 0 });
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toEqual([
        "file",
      ]);
      expect(JSON.stringify(await attached.freeze(50))).toBe(snapshot);
    },
    timeout,
  );

  test(
    "D18.kill-closes-after-held-write: killNow closes the descriptor once after a held write settles, with no closed marker and unchanged status",
    async () => {
      const where = tree();
      const held = heldWriteIo();
      const attached = createDiagnostics(
        { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
        held.io,
      ).attach({
        runId: crypto.randomUUID(),
        commandIdentity: "dxs.read",
        summary: "Kill after held write.",
        signal: new AbortController().signal,
      });
      attached.capability.record("first", { index: 0 });
      await held.writeEntered;
      attached.killNow();
      expect(held.counts().closes).toBe(0);
      held.releaseWrite();
      await held.writeSettled;
      await flushMicrotasks();
      expect(held.counts()).toEqual({ writes: 1, closes: 1, sizeCalls: 0 });
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toEqual([
        "file",
      ]);
      const frozen = await attached.freeze(50);
      expect(get(frozen, "closed")).toBe(false);
      expect(held.counts().closes).toBe(1);
    },
    timeout,
  );

  test(
    "D18.kill-closes-without-finish: killNow closes an open descriptor even when no finish is in progress",
    async () => {
      const where = tree();
      const firstWriteDone = deferred<void>();
      let closes = 0;
      let sizeCalls = 0;
      const io: DiagnosticsIo = {
        open: nodeIo.open,
        size: (descriptor) => {
          sizeCalls += 1;
          return nodeIo.size(descriptor);
        },
        write: async (descriptor, bytes) => {
          const accepted = await nodeIo.write(descriptor, bytes);
          firstWriteDone.resolve();
          return accepted;
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
        summary: "Kill without finish.",
        signal: new AbortController().signal,
      });
      attached.capability.record("only", { index: 0 });
      await firstWriteDone.promise;
      await flushMicrotasks();
      expect(closes).toBe(0);
      attached.killNow();
      await flushMicrotasks();
      expect({ closes, sizeCalls }).toEqual({ closes: 1, sizeCalls: 0 });
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toEqual([
        "file",
      ]);
      const frozen = await attached.freeze(50);
      expect(get(frozen, "closed")).toBe(false);
      expect(closes).toBe(1);
    },
    timeout,
  );

  test(
    "D18.shared-structure-budget: shared references are read at most the budget at last admitted, first refused, and deep DAG sizes",
    () => {
      const make = lineMaker([]);
      let admittedReads = 0;
      const admittedRow = countingRow(100, () => {
        admittedReads += 1;
      });
      const lastAdmitted: unknown[] = [
        ...Array<unknown>(158).fill(admittedRow),
        ...Array<unknown>(41).fill(0),
      ];
      const admittedLine = make(logRecord(lastAdmitted));
      expect(admittedReads).toBe(15_800);
      expect(admittedLine.truncated).toBe(false);

      let refusedReads = 0;
      let tailReads = 0;
      const refusedRow = countingRow(100, () => {
        refusedReads += 1;
      });
      const firstRefused: unknown[] = [
        ...Array<unknown>(158).fill(refusedRow),
        ...Array<unknown>(41).fill(0),
      ];
      Object.defineProperty(firstRefused, firstRefused.length, {
        enumerable: true,
        get() {
          tailReads += 1;
          return 0;
        },
      });
      const refusedLine = make(logRecord(firstRefused));
      expect(refusedReads).toBeLessThanOrEqual(traversalBudget);
      expect(tailReads).toBe(0);
      expect(refusedLine.truncated).toBe(true);

      let dagReads = 0;
      const leaf = {};
      Object.defineProperty(leaf, "leaf", {
        enumerable: true,
        get() {
          dagReads += 1;
          return 1;
        },
      });
      let dag: unknown = leaf;
      for (let level = 0; level < 4; level += 1)
        dag = Array<unknown>(50).fill(dag);
      const dagLine = make(logRecord(dag));
      expect(dagReads).toBeLessThanOrEqual(traversalBudget);
      expect(dagLine.truncated).toBe(true);
    },
    timeout,
  );

  test(
    "D18.own-proto-key-logged: an own __proto__ key survives bounding and appears in the logged record",
    async () => {
      const where = tree();
      const attached = createDiagnostics(
        { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
        nodeIo,
      ).attach({
        runId: crypto.randomUUID(),
        commandIdentity: "dxs.read",
        summary: "Own proto key.",
        signal: new AbortController().signal,
      });
      const payload: Record<string, JsonValue> = { a: 1 };
      Object.defineProperty(payload, "__proto__", {
        value: { kept: "yes" },
        enumerable: true,
      });
      const bounded = boundedValue(payload);
      if (typeof bounded !== "object" || bounded === null)
        throw new Error("no bounded object");
      expect(Object.getPrototypeOf(bounded)).toBeNull();
      expect(Object.hasOwn(bounded, "__proto__")).toBe(true);
      attached.capability.record("proto", payload);
      const frozen = await attached.freeze(500);
      expect(get(frozen, "closed")).toBe(true);
      expect(get(frozen, "truncatedRecords")).toBe(0);
      const log = onlyLog(where.dir);
      const raw = readFileSync(log.path, "utf8");
      expect(raw).toContain('"__proto__":{"kept":"yes"}');
      const [entry] = lines(log.path);
      const facts = get(entry, "facts");
      if (typeof facts !== "object" || facts === null)
        throw new Error("no facts");
      expect(Object.hasOwn(facts, "__proto__")).toBe(true);
      expect(get(facts, "__proto__", "kept")).toBe("yes");
      expect(get(facts, "a")).toBe(1);
    },
    timeout,
  );
});
