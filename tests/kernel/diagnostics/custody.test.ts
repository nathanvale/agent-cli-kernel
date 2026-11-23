import { afterAll, describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  allocate,
  prepare,
} from "../../../kernel/src/addons/diagnostics/custody.ts";
import type {
  Allocation,
  Place,
} from "../../../kernel/src/addons/diagnostics/custody.ts";
import { nodeIo } from "../../../kernel/src/addons/diagnostics/io.ts";
import { turns } from "../lifecycle/recording-host.ts";
import {
  cleanTrees,
  dojo,
  get,
  lines,
  observe,
  open,
  run,
  start,
  tree,
  waitForFile,
  waitForLog,
  waitForRecordBytes,
} from "./harness.ts";
import type { Tree } from "./harness.ts";
import { reportUnproved, unprovedHere } from "./platform.ts";
import {
  expectAvailable,
  expectSuccess,
  expectTwinEqual,
  machine,
  statusOf,
} from "./support.ts";

afterAll(cleanTrees);
const read = ["read", ...machine] as const;
const timeout = 60_000;
const afterFault = { records: 3, pace: true } as const;

function onlyLog(dir: string) {
  const files = observe(dir).files.filter((entry) =>
    entry.name.endsWith(".jsonl"),
  );
  expect(files).toHaveLength(1);
  const [file] = files;
  if (!file) throw new Error("no log");
  return file;
}

function expectSetupRefusal(status: unknown) {
  expectAvailable(status);
  expect(get(status, "status")).toBe("available");
  expect(get(status, "sinkFailure")).toBe("setup");
  expect(get(status, "file")).toBeNull();
}

function mkfifo(path: string) {
  const made = Bun.spawnSync(["/usr/bin/mkfifo", path]);
  if (made.exitCode !== 0)
    throw new Error("UNPROVED on this host: mkfifo failed");
}

function privateParents(where: Tree) {
  mkdirSync(join(where.state, dojo, "dxs"), { recursive: true, mode: 0o700 });
  chmodSync(where.state, 0o700);
  chmodSync(join(where.state, dojo), 0o700);
  chmodSync(join(where.state, dojo, "dxs"), 0o700);
}

describe("D02 private location and modes", () => {
  test(
    "D02.xdg-location: the log is under $XDG_STATE_HOME/my-agent-dojo/dxs/diagnostics",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 2 },
      });
      expectSuccess(result);
      const file = onlyLog(where.dir);
      expect(get(statusOf(result), "file")).toBe(file.path);
      expect(observe(join(where.state, "dxs")).exists).toBe(false);
      expect(observe(join(where.home, ".local")).exists).toBe(false);
    },
    timeout,
  );

  test(
    "D02.home-fallback-location: without XDG_STATE_HOME the log is under $HOME/.local/state/my-agent-dojo/dxs/diagnostics",
    async () => {
      const where = tree();
      const result = await run({ argv: read, tree: where, xdg: false });
      expectSuccess(result);
      const stateRoot = join(where.home, ".local", "state");
      const file = onlyLog(join(stateRoot, dojo, "dxs", "diagnostics"));
      expect(get(statusOf(result), "file")).toBe(file.path);
      expect(observe(join(stateRoot, "dxs")).exists).toBe(false);
      expect(observe(where.state).exists).toBe(false);
    },
    timeout,
  );

  for (const [id, umask] of [
    ["D02.umask-000-modes", "000"],
    ["D02.umask-077-modes", "077"],
  ] as const)
    test(
      `${id}: directory 0700 and file 0600 under umask ${umask}`,
      async () => {
        const where = tree();
        const result = await run({ argv: read, tree: where, umask });
        expectSuccess(result);
        const view = observe(where.dir);
        expect(view.mode).toBe(0o700);
        expect(onlyLog(where.dir).mode).toBe(0o600);
        expect(observe(join(where.state, dojo, "dxs")).mode).toBe(0o700);
        expect(observe(join(where.state, dojo)).mode).toBe(0o700);
        expect(observe(where.state).mode).toBe(0o700);
      },
      timeout,
    );

  test(
    "D02.mode-before-first-byte: the file is 0600 before any record byte lands",
    async () => {
      const where = tree();
      const ready = join(where.root, "ready");
      const go = join(where.root, "go");
      const launched = start({
        argv: read,
        tree: where,
        umask: "000",
        fault: "write-stalls",
        script: { records: 2, hold: { after: 1, ready, go } },
      });
      await waitForFile(ready);
      await waitForLog(where.dir);
      const file = onlyLog(where.dir);
      expect(file.size).toBe(0);
      expect(file.mode).toBe(0o600);
      open(go);
      expectSuccess(await launched.finished);
    },
    timeout,
  );

  test(
    "D02.reported-file-is-inode: the reported path names the inode holding this run's records",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 3 },
      });
      expectSuccess(result);
      const reported = get(statusOf(result), "file");
      if (typeof reported !== "string") throw new Error("no reported file");
      const file = onlyLog(where.dir);
      expect(lstatSync(reported).ino).toBe(file.ino);
      const runId = get(result.envelope, "result", "runId");
      const records = lines(file.path);
      expect(records).toHaveLength(3);
      for (const entry of records) expect(get(entry, "runId")).toBe(runId);
    },
    timeout,
  );

  test(
    "D02.wide-existing-directory: an existing 0755 directory is refused, never written into",
    async () => {
      const where = tree();
      privateParents(where);
      mkdirSync(where.dir);
      chmodSync(where.dir, 0o755);
      const result = await run({ argv: read, tree: where, script: afterFault });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      const view = observe(where.dir);
      expect(view.mode).toBe(0o755);
      expect(view.entries).toHaveLength(0);
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D02.no-location-option: no option or extra variable moves the file",
    async () => {
      const where = tree();
      const elsewhere = join(where.root, "elsewhere");
      mkdirSync(elsewhere);
      const refused = await run({
        argv: ["read", "--diagnostics-dir", elsewhere, ...machine],
        tree: where,
      });
      expect(refused.exit).toBe(2);
      expect(get(refused.envelope, "result", "causeCode")).toBe(
        "USAGE_INVALID_INVOCATION",
      );
      const moved = await run({
        argv: read,
        tree: where,
        env: {
          DXS_DIAGNOSTICS_DIR: elsewhere,
          LOGTAPE_FILE: join(elsewhere, "x.log"),
        },
      });
      expectSuccess(moved);
      expect(observe(elsewhere).entries).toHaveLength(0);
      onlyLog(where.dir);
    },
    timeout,
  );
});

describe("D03 hostile final components", () => {
  test(
    "D03.existing-final-file: an existing file at the final name is never truncated or appended",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: afterFault,
        fault: "plant-file:SENTINEL-BYTES",
      });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      const [planted] = observe(where.dir).files;
      expect(observe(where.dir).files).toHaveLength(1);
      expect(planted ? readFileSync(planted.path, "utf8") : "").toBe(
        "SENTINEL-BYTES",
      );
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D03.symlink-final-component: a symlink at the final name is never followed",
    async () => {
      const where = tree();
      const sentinel = join(where.root, "sentinel");
      writeFileSync(sentinel, "SENTINEL", { mode: 0o644 });
      chmodSync(sentinel, 0o644);
      const before = lstatSync(sentinel);
      const result = await run({
        argv: read,
        tree: where,
        script: afterFault,
        fault: `plant-symlink:${sentinel}`,
      });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      const after = lstatSync(sentinel);
      expect(readFileSync(sentinel, "utf8")).toBe("SENTINEL");
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o7777).toBe(0o644);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D03.symlink-directory: a symlinked diagnostics directory is never followed",
    async () => {
      const where = tree();
      privateParents(where);
      const target = join(where.root, "target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, where.dir);
      const result = await run({ argv: read, tree: where, script: afterFault });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      expect(observe(target).entries).toHaveLength(0);
      expect(lstatSync(where.dir).isSymbolicLink()).toBe(true);
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D03.fifo-final-component: a FIFO at the final name never blocks the run",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: afterFault,
        fault: "plant-fifo",
      });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      expect(observe(where.dir).entries.map((entry) => entry.kind)).toContain(
        "fifo",
      );
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D03.fifo-directory: a FIFO in place of the directory is refused without blocking",
    async () => {
      const where = tree();
      privateParents(where);
      mkfifo(where.dir);
      const result = await run({ argv: read, tree: where, script: afterFault });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      expect(observe(where.dir).kind).toBe("fifo");
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D03.missing-directory: a missing directory is created 0700 before use, whatever the umask",
    async () => {
      const where = tree();
      privateParents(where);
      const result = await run({ argv: read, tree: where, umask: "000" });
      expectSuccess(result);
      expect(observe(where.dir).mode).toBe(0o700);
      expect(onlyLog(where.dir).mode).toBe(0o600);
    },
    timeout,
  );

  test(
    "D03.untrusted-ancestor-writable: a world-writable ancestor without the sticky bit is refused",
    async () => {
      const where = tree();
      mkdirSync(where.state);
      chmodSync(where.state, 0o777);
      const result = await run({ argv: read, tree: where, script: afterFault });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      expect(observe(where.state).entries).toHaveLength(0);
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D03.untrusted-ancestor-writable: a group-writable my-agent-dojo folder is refused, nothing written there",
    async () => {
      const where = tree();
      mkdirSync(join(where.state, dojo), { recursive: true, mode: 0o700 });
      chmodSync(where.state, 0o700);
      chmodSync(join(where.state, dojo), 0o770);
      const result = await run({ argv: read, tree: where, script: afterFault });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      expect(observe(join(where.state, dojo)).entries).toHaveLength(0);
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );
});

describe("D04 handle custody", () => {
  test(
    "D04.rename-replace-after-open: later records land in the opened inode, never the replacement",
    async () => {
      const where = tree();
      const ready = join(where.root, "ready");
      const go = join(where.root, "go");
      const launched = start({
        argv: read,
        tree: where,
        script: { records: 4, hold: { after: 1, ready, go } },
      });
      await waitForFile(ready);
      await waitForRecordBytes(where.dir);
      const original = onlyLog(where.dir);
      const moved = join(where.root, "moved.jsonl");
      renameSync(original.path, moved);
      writeFileSync(original.path, "REPLACEMENT\n", { mode: 0o600 });
      open(go);
      const result = await launched.finished;
      expectSuccess(result);
      expect(readFileSync(original.path, "utf8")).toBe("REPLACEMENT\n");
      expect(lstatSync(moved).ino).toBe(original.ino);
      expect(lines(moved).map((entry) => get(entry, "facts", "index"))).toEqual(
        [0, 1, 2, 3],
      );
      expect(get(statusOf(result), "unflushedRecords")).toBe(0);
    },
    timeout,
  );

  test(
    "D04.ancestor-swap-unsupported-destination: a directory swapped before open is refused, nothing written",
    async () => {
      const where = tree();
      const ready = join(where.root, "ready");
      const go = join(where.root, "go");
      const elsewhere = join(where.root, "elsewhere");
      mkdirSync(elsewhere, { mode: 0o700 });
      const launched = start({
        argv: read,
        tree: where,
        fault: `open-barrier:${ready}:${go}`,
        script: afterFault,
      });
      await waitForFile(ready);
      renameSync(where.dir, `${where.dir}.orig`);
      symlinkSync(elsewhere, where.dir);
      open(go);
      const result = await launched.finished;
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      // Platform: open(O_CREAT | O_NOFOLLOW) follows a swapped ancestor and may create a 0-byte file.
      for (const entry of observe(elsewhere).files) expect(entry.size).toBe(0);
      expect(observe(`${where.dir}.orig`).files).toHaveLength(0);
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );
});

describe("D09 setup faults", () => {
  test(
    "D09.unset-home-and-xdg: no home and no state directory leave the result unchanged",
    async () => {
      const where = tree();
      const result = await run({
        argv: read,
        tree: where,
        script: afterFault,
        xdg: false,
        home: false,
      });
      expectSuccess(result);
      expectSetupRefusal(statusOf(result));
      await expectTwinEqual(result, { argv: read, script: afterFault });
    },
    timeout,
  );

  test(
    "D09.unwritable-ancestor: an unwritable state root leaves the result unchanged",
    async () => {
      const where = tree();
      mkdirSync(where.state, { mode: 0o500 });
      chmodSync(where.state, 0o500);
      try {
        const result = await run({
          argv: read,
          tree: where,
          script: afterFault,
        });
        expectSuccess(result);
        expectSetupRefusal(statusOf(result));
        expect(observe(where.state).entries).toHaveLength(0);
        await expectTwinEqual(result, { argv: read, script: afterFault });
      } finally {
        chmodSync(where.state, 0o700);
      }
    },
    timeout,
  );

  const noSpaceUnproved = unprovedHere("D09.no-space-volume");
  if (noSpaceUnproved !== undefined)
    test(`D09.no-space-volume: UNPROVED on ${process.platform}`, () => {
      expect(noSpaceUnproved.length).toBeGreaterThan(0);
      reportUnproved("D09.no-space-volume", noSpaceUnproved);
    });
  else
    test(
      "D09.no-space-volume: a full state volume leaves the result unchanged",
      async () => {
        const where = tree();
        const image = join(where.root, "vol.dmg");
        const mount = join(where.root, "vol");
        mkdirSync(mount);
        const made = Bun.spawnSync([
          "/usr/bin/hdiutil",
          "create",
          "-size",
          "2m",
          "-fs",
          "HFS+",
          "-volname",
          "t5diag",
          image,
        ]);
        if (made.exitCode !== 0)
          throw new Error(
            `UNPROVED on this host: hdiutil create refused (${made.stderr.toString()})`,
          );
        const attached = Bun.spawnSync([
          "/usr/bin/hdiutil",
          "attach",
          "-nobrowse",
          "-mountpoint",
          mount,
          image,
        ]);
        if (attached.exitCode !== 0)
          throw new Error(
            `UNPROVED on this host: hdiutil attach refused (${attached.stderr.toString()})`,
          );
        try {
          const state = join(mount, "state");
          const dir = join(state, dojo, "dxs", "diagnostics");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          for (const path of [
            state,
            join(state, dojo),
            join(state, dojo, "dxs"),
            dir,
          ])
            chmodSync(path, 0o700);
          const filler = join(mount, "filler");
          Bun.spawnSync(["/bin/dd", "if=/dev/zero", `of=${filler}`, "bs=64k"]);
          const result = await run({
            argv: read,
            tree: { ...where, state, dir },
            script: { records: 20, size: 4000 },
          });
          expectSuccess(result);
          const status = statusOf(result);
          expectAvailable(status);
          expect(
            ["setup", "write"].includes(String(get(status, "sinkFailure"))),
          ).toBe(true);
          await expectTwinEqual(result, {
            argv: read,
            script: { records: 20 },
          });
        } finally {
          Bun.spawnSync(["/usr/bin/hdiutil", "detach", mount, "-force"]);
        }
      },
      timeout,
    );
});

const lockWaitOracle = 200;
const retryIntervalOracle = 10;
const lateBy = 20;
const turnBound = 1_000;

function freePlace(): Place {
  const place = prepare(tree().dir);
  if (!place) throw new Error("The test tree has no private directory.");
  return place;
}

function heldLock(): Place {
  const place = freePlace();
  const lock = join(place.directory, ".allocation-lock");
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "holder"), "");
  return place;
}

async function waitForLock(
  place: Place,
  lateness: (wake: number) => number,
  abandonedAfter: (elapsed: number) => boolean = () => false,
) {
  jest.useFakeTimers();
  try {
    const began = performance.now();
    const outcome: {
      settled?: { readonly allocation: Allocation; readonly elapsed: number };
    } = {};
    void allocate(place, "lock-wait", nodeIo, () =>
      abandonedAfter(performance.now() - began),
    ).then((allocation) => {
      outcome.settled = { allocation, elapsed: performance.now() - began };
    });
    let wakes = 0;
    for (let turn = 0; !outcome.settled && turn < turnBound; turn += 1) {
      await turns(1);
      if (jest.getTimerCount() > 0) {
        jest.advanceTimersToNextTimer();
        const late = lateness(wakes);
        // Platform: Bun's jest.advanceTimersByTime(0) moves the fake clock 1 ms.
        if (late > 0) jest.advanceTimersByTime(late);
        wakes += 1;
      }
    }
    if (!outcome.settled)
      throw new Error(`The lock wait did not settle in ${turnBound} turns.`);
    return { ...outcome.settled, wakes };
  } finally {
    jest.useRealTimers();
  }
}

test("the allocation lock wait ends at its limit by the clock when every retry wakes late", async () => {
  const { allocation, elapsed } = await waitForLock(heldLock(), () => lateBy);
  expect(allocation).toBe("capacity");
  expect(elapsed).toBeGreaterThanOrEqual(lockWaitOracle);
  expect(elapsed).toBeLessThanOrEqual(lockWaitOracle + lateBy);
});

test("an abandoned run ends the allocation lock wait before its limit", async () => {
  const { allocation, elapsed } = await waitForLock(
    heldLock(),
    () => lateBy,
    (elapsedSoFar) => elapsedSoFar >= 2 * lateBy,
  );
  expect(allocation).toBe("abandoned");
  expect(elapsed).toBeLessThan(lockWaitOracle);
});

test("with every retry woken on time the allocation lock wait wakes every 10 ms and ends at exactly 200 ms", async () => {
  const { allocation, elapsed, wakes } = await waitForLock(heldLock(), () => 0);
  expect(allocation).toBe("capacity");
  expect(elapsed).toBe(lockWaitOracle);
  expect(wakes).toBe(lockWaitOracle / retryIntervalOracle);
});

test("the allocation lock wait arms its last retry for only the time left before its limit", async () => {
  const { allocation, elapsed } = await waitForLock(heldLock(), (wake) =>
    wake === 0 ? 3 : 0,
  );
  expect(allocation).toBe("capacity");
  expect(elapsed).toBe(lockWaitOracle);
});

test("the allocation lock wait tries the lock once even when its limit has passed by the first try", async () => {
  const checks = { count: 0 };
  const { allocation } = await waitForLock(
    freePlace(),
    () => 0,
    () => {
      checks.count += 1;
      if (checks.count === 1) jest.advanceTimersByTime(lockWaitOracle + lateBy);
      return false;
    },
  );
  if (typeof allocation !== "object")
    throw new Error(`The free lock was not taken: ${allocation}.`);
  closeSync(allocation.descriptor);
});

const localHost = createHash("sha256")
  .update(hostname())
  .digest("hex")
  .slice(0, 16);
const foreignHost =
  localHost === "0000000000000000" ? "1111111111111111" : "0000000000000000";

test(
  "unusable diagnostics folder drops first-turn records and leaves none unflushed",
  async () => {
    const unset = await run({
      argv: read,
      tree: tree(),
      script: { records: 3 },
      xdg: false,
      home: false,
    });
    expectSuccess(unset);
    expect(statusOf(unset)).toEqual({
      status: "available",
      file: null,
      sinkFailure: "setup",
      droppedRecords: 3,
      unflushedRecords: 0,
      truncatedRecords: 0,
      countsComplete: true,
      closed: false,
    });

    const where = tree();
    privateParents(where);
    mkdirSync(where.dir);
    chmodSync(where.dir, 0o755);
    const wide = await run({
      argv: read,
      tree: where,
      script: { records: 3 },
    });
    expectSuccess(wide);
    expect(statusOf(wide)).toEqual({
      status: "available",
      file: null,
      sinkFailure: "setup",
      droppedRecords: 3,
      unflushedRecords: 0,
      truncatedRecords: 0,
      countsComplete: true,
      closed: false,
    });
  },
  timeout,
);

test("removeIfPresent rethrows non-ENOENT cleanup errors so allocation reports setup", async () => {
  const place = freePlace();
  const exited = Bun.spawn([process.execPath, "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await exited.exited;
  const residue = join(
    place.directory,
    `.allocation-lock.pending-${exited.pid}-${localHost}-0000000000000000`,
  );
  mkdirSync(join(residue, "nested"), { recursive: true, mode: 0o700 });
  const allocation = await allocate(
    place,
    "residue-error",
    nodeIo,
    () => false,
  );
  if (typeof allocation === "object") closeSync(allocation.descriptor);
  expect(allocation).toBe("setup");
});

test("unlinkIfPresent returns false on non-ENOENT lock-entry errors so allocation reports capacity", async () => {
  const place = freePlace();
  const lock = join(place.directory, ".allocation-lock");
  mkdirSync(join(lock, `owner-99999-${foreignHost}`), {
    recursive: true,
    mode: 0o700,
  });
  const stale = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(lock, stale, stale);
  const { allocation } = await waitForLock(place, () => 0);
  if (typeof allocation === "object") closeSync(allocation.descriptor);
  expect(allocation).toBe("capacity");
});
