import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createDiagnostics } from "../../../kernel/src/addons/diagnostics/run.ts";
import { nodeIo } from "../../../kernel/src/addons/diagnostics/io.ts";
import type { DiagnosticsIo } from "../../../kernel/src/addons/diagnostics/io.ts";
import {
  cleanTrees,
  crashTimeout,
  get,
  lines,
  observe,
  open,
  run,
  runCrash,
  start,
  tree,
  waitForFile,
  waitForLog,
  waitForRecordBytes,
} from "./harness.ts";
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
const timeout = 60_000;

function onlyLog(dir: string) {
  const [log] = observe(dir).files.filter((entry) =>
    entry.name.endsWith(".jsonl"),
  );
  if (!log) throw new Error("no log");
  return log;
}

async function heldRun(
  script: Record<string, unknown>,
  during: (where: ReturnType<typeof tree>) => void,
  fault?: string,
) {
  const where = tree();
  const ready = join(where.root, "ready");
  const go = join(where.root, "go");
  const launched = start({
    argv: read,
    tree: where,
    script: { ...script, hold: { after: 1, ready, go } },
    fault,
  });
  await waitForFile(ready);
  await waitForRecordBytes(where.dir);
  during(where);
  open(go);
  return { where, result: await launched.finished };
}

describe("D13 result noninterference", () => {
  const script = { records: 4, pace: true };

  test(
    "D13.directory-deleted-mid-run: deleting the diagnostics tree mid-run changes nothing in the result",
    async () => {
      const { where, result } = await heldRun(script, (tree) =>
        rmSync(join(tree.state, "dxs"), { recursive: true }),
      );
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script });
      expectAvailable(statusOf(result));
      expect(get(statusOf(result), "sinkFailure")).toBeNull();
      expect(get(statusOf(result), "closed")).toBe(true);
      expect(existsSync(where.dir)).toBe(false);
    },
    timeout,
  );

  test(
    "D13.log-corrupted: corrupting the log mid-run changes nothing in the result",
    async () => {
      const { where, result } = await heldRun(script, (tree) =>
        appendFileSync(onlyLog(tree.dir).path, "CORRUPT\n"),
      );
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script });
      const status = statusOf(result);
      expectUnavailable(status, "status-invalid");
      expect(get(status, "status")).toBe("unavailable");
      expect(get(status, "reason")).toBe("status-invalid");
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toEqual([
        "file",
      ]);
    },
    timeout,
  );

  test(
    "D13.sink-throwing: a throwing sink changes nothing in the result",
    async () => {
      const result = await run({
        argv: read,
        tree: tree(),
        fault: "write-throws",
        script,
      });
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script });
      expect(get(statusOf(result), "sinkFailure")).toBe("write");
    },
    timeout,
  );

  test(
    "D13.disabled-twin: the intact and the disabled CLI give the same canonical result",
    async () => {
      const intact = await run({ argv: read, tree: tree(), script });
      expectSuccess(intact);
      expect(get(statusOf(intact), "sinkFailure")).toBeNull();
      await expectTwinEqual(intact, { argv: read, script });
    },
    timeout,
  );
});

describe("D17 finalisation freeze", () => {
  test(
    "D17.no-change-after-freeze (component layer; the process row is UNPROVED): after the freeze no record is admitted and the log never changes",
    async () => {
      const where = tree();
      let writes = 0;
      const io: DiagnosticsIo = {
        ...nodeIo,
        write: (descriptor, bytes) => {
          writes += 1;
          return nodeIo.write(descriptor, bytes);
        },
      };
      const attached = createDiagnostics(
        { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
        io,
      ).attach({
        runId: crypto.randomUUID(),
        commandIdentity: "dxs.read",
        summary: "Freeze.",
        signal: new AbortController().signal,
      });
      attached.capability.record("before", { index: 0 });
      const frozen = await attached.freeze(500);
      expect(get(frozen, "closed")).toBe(true);
      const log = onlyLog(where.dir);
      const before = statSync(log.path);
      const writesAtFreeze = writes;
      for (let index = 0; index < 100; index += 1)
        attached.capability.record("after", { index });
      await attached.settle(300);
      await new Promise((resolve) => setImmediate(resolve));
      const after = statSync(log.path);
      expect(writes).toBe(writesAtFreeze);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(JSON.stringify(await attached.freeze(500))).toBe(
        JSON.stringify(frozen),
      );
      expect(lines(log.path).map((entry) => get(entry, "event"))).toEqual([
        "before",
      ]);
    },
    timeout,
  );

  test(
    "D17.epipe-not-logged: a reader that closes stdout causes no diagnostic activity",
    async () => {
      const where = tree();
      const ready = join(where.root, "ready");
      const go = join(where.root, "go");
      const exitFile = join(where.root, "exit");
      const closed = join(where.root, "closed");
      const launched = start({
        argv: [],
        tree: where,
        script: { records: 3, hold: { after: 3, ready, go } },
        shell: `"$@" read --json | { exec 0<&-; : > "${closed}"; }; echo "\${PIPESTATUS[0]}" > "${exitFile}"`,
      });
      await waitForFile(ready);
      await waitForFile(closed);
      open(go);
      const outer = await launched.finished;
      expect(outer.stdout).toBe("");
      expect(readFileSync(exitFile, "utf8").trim()).toBe("1");
      const log = onlyLog(where.dir);
      const text = readFileSync(log.path, "utf8");
      expect(lines(log.path)).toHaveLength(3);
      expect(text).not.toMatch(/EPIPE|broken pipe/i);
    },
    timeout,
  );

  test(
    "D17.crash-no-status: a crash emits no envelope and promises no status",
    async () => {
      const result = await runCrash({
        argv: read,
        tree: tree(),
        script: { records: 2, crash: true },
      });
      expect(result.stdout).toBe("");
      expect(result.signal ?? String(result.exit)).not.toBe("0");
      expect(result.envelope).toBeUndefined();
    },
    crashTimeout,
  );

  test(
    "D17.first-signal-flush-bound: a first SIGINT exits 130 within the stop bound despite a stuck flush",
    async () => {
      const where = tree();
      const ready = join(where.root, "ready");
      const go = join(where.root, "go");
      const launched = start({
        argv: read,
        tree: where,
        fault: "write-stalls",
        script: { records: 3, hold: { after: 3, ready, go } },
      });
      await waitForFile(ready);
      const sent = performance.now();
      launched.child.kill("SIGINT");
      const result = await launched.finished;
      const took = performance.now() - sent;
      expect(result.exit).toBe(130);
      expect(result.stdout).toBe("");
      expect(took).toBeLessThanOrEqual(600);
    },
    timeout,
  );
});

test(
  "finishWork drains a record queued while the previous drain is finishing",
  async () => {
    const where = tree();
    let firstWrite:
      | {
          readonly descriptor: number;
          readonly bytes: Uint8Array;
          readonly resolve: (count: number) => void;
        }
      | undefined;
    let writes = 0;
    const io: DiagnosticsIo = {
      ...nodeIo,
      write: (descriptor, bytes) => {
        writes += 1;
        if (writes === 1)
          return new Promise<number>((resolve) => {
            firstWrite = { descriptor, bytes, resolve };
          });
        return nodeIo.write(descriptor, bytes);
      },
    };
    const attached = createDiagnostics(
      { cli: "dxs", environment: { XDG_STATE_HOME: where.state } },
      io,
    ).attach({
      runId: crypto.randomUUID(),
      commandIdentity: "dxs.read",
      summary: "Finish loop.",
      signal: new AbortController().signal,
    });
    attached.capability.record("first", { index: 0 });
    await waitForLog(where.dir);
    while (firstWrite === undefined)
      await new Promise((resolve) => setImmediate(resolve));
    const written = await nodeIo.write(firstWrite.descriptor, firstWrite.bytes);
    firstWrite.resolve(written);
    await Promise.resolve();
    await Promise.resolve();
    attached.capability.record("second", { index: 1 });
    const frozen = await attached.freeze(500);
    expect(get(frozen, "sinkFailure")).toBeNull();
    expect(get(frozen, "unflushedRecords")).toBe(0);
    expect(get(frozen, "droppedRecords")).toBe(0);
    expect(get(frozen, "closed")).toBe(true);
    expect(
      lines(onlyLog(where.dir).path).map((entry) => get(entry, "event")),
    ).toEqual(["first", "second"]);
  },
  timeout,
);
