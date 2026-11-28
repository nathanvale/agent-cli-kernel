import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
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
const waitBoundMilliseconds = 5_000;
const traversalBudget = 16_000;

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitWithin<Value>(
  work: Promise<Value>,
  label: string,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} did not happen within ${waitBoundMilliseconds} ms.`,
          ),
        ),
      waitBoundMilliseconds,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
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

function trackedIo(holdFirstWrite: boolean) {
  const writeEntered = deferred<void>();
  const releaseWrite = deferred<void>();
  const writeSettled = deferred<void>();
  const closeCalled = deferred<void>();
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
        if (holdFirstWrite) await releaseWrite.promise;
      }
      const accepted = await nodeIo.write(descriptor, bytes);
      if (writes === 1) writeSettled.resolve();
      return accepted;
    },
    close: (descriptor) => {
      closes += 1;
      nodeIo.close(descriptor);
      closeCalled.resolve();
    },
  };
  return {
    io,
    writeEntered: writeEntered.promise,
    releaseWrite: releaseWrite.resolve,
    writeSettled: writeSettled.promise,
    closeCalled: closeCalled.promise,
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

function countingObject(keys: number, onRead: () => void): object {
  const target: Record<string, unknown> = {};
  for (let index = 0; index < keys; index += 1)
    Object.defineProperty(target, `k${index}`, {
      enumerable: true,
      get() {
        onRead();
        return 0;
      },
    });
  return target;
}

describe("S10, S11, N4 diagnostics close on freeze/kill and traversal budget", () => {
  test(
    "S10.flush-timeout-closes-descriptor: a flush timeout closes the descriptor once after the held write settles, with no closed marker and unchanged status",
    async () => {
      const where = tree();
      const held = trackedIo(true);
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
      await waitWithin(held.writeEntered, "first write entry");
      const frozen = await attached.freeze(50);
      const snapshot = JSON.stringify(frozen);
      expect(get(frozen, "sinkFailure")).toBe("flush-timeout");
      expect(get(frozen, "closed")).toBe(false);
      expect(held.counts().closes).toBe(0);
      held.releaseWrite();
      await waitWithin(held.writeSettled, "first write settle");
      await waitWithin(
        held.closeCalled,
        "descriptor close after flush timeout",
      );
      expect(held.counts()).toEqual({ writes: 1, closes: 1, sizeCalls: 0 });
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toEqual([
        "file",
      ]);
      expect(JSON.stringify(await attached.freeze(50))).toBe(snapshot);
    },
    timeout,
  );

  test(
    "S10.kill-closes-after-held-write: killNow closes the descriptor once after a held write settles, with no closed marker and unchanged status",
    async () => {
      const where = tree();
      const held = trackedIo(true);
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
      await waitWithin(held.writeEntered, "first write entry");
      attached.killNow();
      expect(held.counts().closes).toBe(0);
      held.releaseWrite();
      await waitWithin(held.writeSettled, "first write settle");
      await waitWithin(held.closeCalled, "descriptor close after kill");
      expect(held.counts()).toEqual({ writes: 1, closes: 1, sizeCalls: 0 });
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toEqual([
        "file",
      ]);
      const frozen = await attached.freeze(50);
      expect(get(frozen, "status")).toBe("available");
      expect(get(frozen, "closed")).toBe(false);
      expect(get(frozen, "sinkFailure")).toBeNull();
      expect(JSON.stringify(await attached.freeze(50))).toBe(
        JSON.stringify(frozen),
      );
      expect(held.counts().closes).toBe(1);
    },
    timeout,
  );

  test(
    "S10.kill-closes-without-finish: killNow closes an open descriptor at once when idle and no finish is in progress",
    async () => {
      const where = tree();
      const tracked = trackedIo(false);
      const attached = createDiagnostics(
        { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
        tracked.io,
      ).attach({
        runId: crypto.randomUUID(),
        commandIdentity: "dxs.read",
        summary: "Kill without finish.",
        signal: new AbortController().signal,
      });
      attached.capability.record("only", { index: 0 });
      await waitWithin(tracked.writeSettled, "first write settle");
      const info = await waitWithin(
        stat(onlyLog(where.dir).path),
        "log file stat after write",
      );
      expect(info.size).toBeGreaterThan(0);
      expect(tracked.counts().closes).toBe(0);
      attached.killNow();
      expect(tracked.counts()).toEqual({ writes: 1, closes: 1, sizeCalls: 0 });
      attached.killNow();
      expect(tracked.counts().closes).toBe(1);
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toEqual([
        "file",
      ]);
      const frozen = await attached.freeze(50);
      expect(get(frozen, "closed")).toBe(false);
      expect(tracked.counts().closes).toBe(1);
    },
    timeout,
  );

  test(
    "S10.kill-after-close-does-not-double-close: killNow after a finished close keeps the close count at 1",
    async () => {
      const where = tree();
      const tracked = trackedIo(false);
      const attached = createDiagnostics(
        { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
        tracked.io,
      ).attach({
        runId: crypto.randomUUID(),
        commandIdentity: "dxs.read",
        summary: "Kill after finished close.",
        signal: new AbortController().signal,
      });
      attached.capability.record("only", { index: 0 });
      const frozen = await attached.freeze(500);
      expect(get(frozen, "closed")).toBe(true);
      expect(tracked.counts().closes).toBe(1);
      attached.killNow();
      attached.killNow();
      await attached.settle(50);
      expect(tracked.counts().closes).toBe(1);
    },
    timeout,
  );

  test(
    "S11.shared-structure-budget: shared references are read at most the budget at last admitted, first refused, shared object, and deep DAG sizes",
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

      let objectReads = 0;
      const sharedObject = countingObject(100, () => {
        objectReads += 1;
      });
      const objectLine = make(
        logRecord(Array<unknown>(200).fill(sharedObject)),
      );
      expect(objectReads).toBeLessThanOrEqual(traversalBudget);
      expect(objectLine.truncated).toBe(true);

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
    "S11.plain-object-budget: a plain-object root stops at the traversal budget at last admitted, first refused, and repeated large object sizes",
    () => {
      const make = lineMaker([]);
      let admittedReads = 0;
      const admittedRow = countingRow(100, () => {
        admittedReads += 1;
      });
      const lastAdmitted: Record<string, unknown> = {};
      for (let index = 0; index < 158; index += 1)
        lastAdmitted[`r${index}`] = admittedRow;
      for (let index = 0; index < 41; index += 1)
        Object.defineProperty(lastAdmitted, `s${index}`, {
          enumerable: true,
          get() {
            admittedReads += 1;
            return 0;
          },
        });
      const admittedLine = make(logRecord(lastAdmitted));
      expect(admittedReads).toBe(15_841);
      expect(admittedLine.truncated).toBe(false);

      let refusedReads = 0;
      let tailReads = 0;
      const refusedRow = countingRow(100, () => {
        refusedReads += 1;
      });
      const firstRefused: Record<string, unknown> = {};
      for (let index = 0; index < 158; index += 1)
        firstRefused[`r${index}`] = refusedRow;
      for (let index = 0; index < 41; index += 1)
        Object.defineProperty(firstRefused, `s${index}`, {
          enumerable: true,
          get() {
            refusedReads += 1;
            return 0;
          },
        });
      Object.defineProperty(firstRefused, "tail", {
        enumerable: true,
        get() {
          tailReads += 1;
          return 0;
        },
      });
      const refusedLine = make(logRecord(firstRefused));
      expect(refusedReads).toBe(15_841);
      expect(tailReads).toBe(0);
      expect(refusedLine.truncated).toBe(true);

      let wideReads = 0;
      const sharedLarge = countingObject(1_000, () => {
        wideReads += 1;
      });
      const wideRoot: Record<string, unknown> = {};
      for (let index = 0; index < 500; index += 1)
        Object.defineProperty(wideRoot, `k${index}`, {
          enumerable: true,
          get() {
            wideReads += 1;
            return 0;
          },
        });
      for (let index = 0; index < 20; index += 1)
        Object.defineProperty(wideRoot, `ref${index}`, {
          enumerable: true,
          get() {
            wideReads += 1;
            return sharedLarge;
          },
        });
      const wideLine = make(logRecord(wideRoot));
      expect(wideReads).toBeLessThanOrEqual(traversalBudget);
      expect(wideLine.truncated).toBe(true);
    },
    timeout,
  );

  test(
    "N4.own-proto-key-logged: an own __proto__ key survives bounding with a null prototype and appears in the logged record",
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
