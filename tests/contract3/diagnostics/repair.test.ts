// Repair round 1 controls (t5-repair-1-cases.json): a declared secret that
// cannot be read whole, record lines with a short secret, a stale coordination
// lock from another host, and a late write at the process layer.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  cleanTrees,
  get,
  lines,
  observe,
  open as release,
  run,
  start,
  tree,
  waitForFile,
} from "./harness.ts";
import type { Run, Tree } from "./harness.ts";
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

function privateDirectory(where: Tree) {
  mkdirSync(where.dir, { recursive: true, mode: 0o700 });
  for (const path of [where.state, join(where.state, "dxs"), where.dir])
    chmodSync(path, 0o700);
}

describe("SF4 a declared secret that cannot be read whole stops diagnostics", () => {
  async function unreadSecret(where: Tree, input: string, secret: string) {
    const launch = {
      argv: ["read", "--token-file", input, ...machine],
      script: { records: 3, secretFacts: true, pace: true },
    };
    const result = await run({ ...launch, tree: where });
    // Positive outcome first.
    expectSuccess(result);
    await expectTwinEqual(result, launch);
    const status = statusOf(result);
    expectAvailable(status);
    expect(status).toEqual({
      status: "available",
      file: null,
      sinkFailure: "setup",
      droppedRecords: 3,
      unflushedRecords: 0,
      truncatedRecords: 0,
      countsComplete: true,
      closed: false,
    });
    // Then: nothing was logged, and the secret is nowhere but its own file.
    expect(observe(where.dir).exists).toBe(false);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    for (const path of everyFile(where.root).filter((path) => path !== input))
      expect(readFileSync(path, "utf8")).not.toContain(secret);
  }

  test(
    "R1.secret-file-oversize-stops: a declared secret file above the read bound is never logged in clear",
    async () => {
      const where = tree();
      const secret = `T5SYNTHMARKER-oversize-${crypto.randomUUID()}`;
      const input = join(where.root, "token.txt");
      writeFileSync(input, `${secret}\n${"x".repeat(70_000)}\n`, {
        mode: 0o600,
      });
      await unreadSecret(where, input, secret);
    },
    timeout,
  );

  test(
    "R1.secret-file-unreadable-stops: an unreadable declared secret file is never logged in clear",
    async () => {
      const where = tree();
      const secret = `T5SYNTHMARKER-unreadable-${crypto.randomUUID()}`;
      const input = join(where.root, "token.txt");
      writeFileSync(input, `${secret}\n`, { mode: 0o600 });
      chmodSync(input, 0o000);
      try {
        await unreadSecret(where, input, secret);
      } finally {
        chmodSync(input, 0o600);
      }
    },
    timeout,
  );
});

describe("LOW record lines stay valid with a short secret", () => {
  test(
    "R1.short-secret-lines-valid: a one-character secret never rewrites numbers or identities",
    async () => {
      const where = tree();
      const result = await run({
        argv: ["read", "--token", "3", ...machine],
        tree: where,
        script: { records: 5, secretFacts: true },
      });
      expectSuccess(result);
      const [log] = observe(where.dir).files;
      if (!log) throw new Error("no log");
      const text = readFileSync(log.path, "utf8");
      const parsed = text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line): unknown => JSON.parse(line));
      expect(parsed).toHaveLength(5);
      const runId = get(result.envelope, "result", "runId");
      parsed.forEach((entry, index) => {
        expect(get(entry, "runId")).toBe(runId);
        expect(get(entry, "seq")).toBe(index + 1);
        expect(typeof get(entry, "elapsedMilliseconds")).toBe("number");
        expect(get(entry, "facts", "note")).toBe("[REDACTED]");
      });
    },
    timeout,
  );
});

describe("SF3 a stale coordination lock from another host", () => {
  const localHost = createHash("sha256")
    .update(hostname())
    .digest("hex")
    .slice(0, 16);
  const foreignHost =
    localHost === "0000000000000000" ? "1111111111111111" : "0000000000000000";

  function plantLock(where: Tree, ageMilliseconds: number) {
    privateDirectory(where);
    const lock = join(where.dir, ".allocation-lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, `owner-99999-${foreignHost}`), "", {
      mode: 0o600,
    });
    const when = new Date(Date.now() - ageMilliseconds);
    utimesSync(lock, when, when);
    return lock;
  }

  test(
    "R1.foreign-host-old-lock-recovered: an abandoned foreign-host lock is recovered and the run logs",
    async () => {
      const where = tree();
      const lock = plantLock(where, 10 * 60 * 1000);
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 2 },
      });
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script: { records: 2 } });
      const status = statusOf(result);
      expectAvailable(status);
      expect(get(status, "sinkFailure")).toBeNull();
      expect(lines(String(get(status, "file")))).toHaveLength(2);
      expect(existsSync(lock)).toBe(false);
    },
    timeout,
  );

  test(
    "R1.foreign-host-fresh-lock-capacity: a lock that may be live is disclosed as capacity within the flush bound",
    async () => {
      const where = tree();
      const lock = plantLock(where, 0);
      const intact = await run({
        argv: read,
        tree: tree(),
        script: { records: 2 },
      });
      const result: Run = await run({
        argv: read,
        tree: where,
        script: { records: 2 },
      });
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script: { records: 2 } });
      const status = statusOf(result);
      expectAvailable(status);
      expect(get(status, "sinkFailure")).toBe("capacity");
      expect(get(status, "file")).toBeNull();
      expect(readdirSync(lock)).toEqual([`owner-99999-${foreignHost}`]);
      // DIAG-14's 500 ms flush bound plus the 100 ms process-noise allowance
      // the lifecycle suites use. The decisive check is `capacity` above: a
      // lock wait past the add-on's 450 ms budget would read flush-timeout.
      expect(
        result.elapsedMilliseconds - intact.elapsedMilliseconds,
      ).toBeLessThanOrEqual(500 + 100);
    },
    timeout,
  );

  // Twins either side of the 60 s rule. A malformed lock is never recovered,
  // so the recovered twin also shows the planted owner reads as foreign.
  test(
    "R2.foreign-lock-boundary-held: a foreign-host lock 59 s old is still treated as held",
    async () => {
      const where = tree();
      const lock = plantLock(where, 59_000);
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 2 },
      });
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script: { records: 2 } });
      expect(get(statusOf(result), "sinkFailure")).toBe("capacity");
      expect(existsSync(lock)).toBe(true);
    },
    timeout,
  );

  test(
    "R2.foreign-lock-boundary-recovered: a foreign-host lock 61 s old is recovered",
    async () => {
      const where = tree();
      const lock = plantLock(where, 61_000);
      const result = await run({
        argv: read,
        tree: where,
        script: { records: 2 },
      });
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script: { records: 2 } });
      expect(get(statusOf(result), "sinkFailure")).toBeNull();
      expect(existsSync(lock)).toBe(false);
    },
    timeout,
  );
});

describe("SF5 a late write at the process layer", () => {
  test(
    "R1.late-completion-process: pending work is abandoned at expiry: a write still pending when the process ends never lands, and there is no second output",
    async () => {
      const where = tree();
      const script = { records: 2 };
      const result = await run({
        argv: read,
        tree: where,
        fault: "write-delays:900",
        script,
      });
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script });
      expect(
        result.stdout.split("\n").filter((line) => line.length > 0),
      ).toHaveLength(1);
      const status = statusOf(result);
      expectAvailable(status);
      expect(get(status, "sinkFailure")).toBe("flush-timeout");
      expect(get(status, "unflushedRecords")).toBe(2);
      expect(get(status, "closed")).toBe(false);
      // The process ended before the delayed write could land.
      const [log] = observe(where.dir).files;
      expect(log?.size).toBe(0);
    },
    timeout,
  );
});

describe("Repair round 2: non-string secrets, an observed late completion, a symlinked <cli> directory", () => {
  function logText(where: Tree): string {
    const [log] = observe(where.dir).files;
    if (!log) throw new Error("no log");
    return readFileSync(log.path, "utf8");
  }

  test(
    "R2.non-string-secrets-concealed: a secret recorded as a number, nested or as a numeric string never appears",
    async () => {
      const where = tree();
      const secret = "731290";
      const launch = {
        argv: ["read", "--token", secret, ...machine],
        script: { records: 2, secretFacts: true },
      };
      const result = await run({ ...launch, tree: where });
      expectSuccess(result);
      await expectTwinEqual(result, launch);
      const text = logText(where);
      const parsed = text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line): unknown => JSON.parse(line));
      expect(parsed).toHaveLength(2);
      for (const entry of parsed) {
        expect(get(entry, "facts", "typed")).toBe("[REDACTED]");
        expect(get(entry, "facts", "nested", "inner")).toEqual(["[REDACTED]"]);
        expect(get(entry, "facts", "note")).toBe("[REDACTED]");
      }
      expect(text).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
    },
    timeout,
  );

  test(
    "R2.boolean-secret-concealed: a secret recorded as a boolean never appears",
    async () => {
      const where = tree();
      const launch = {
        argv: ["read", "--token", "true", ...machine],
        script: { records: 1, secretFacts: true },
      };
      const result = await run({ ...launch, tree: where });
      expectSuccess(result);
      await expectTwinEqual(result, launch);
      const [entry] = logText(where)
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line): unknown => JSON.parse(line));
      expect(get(entry, "facts", "typed")).toBe("[REDACTED]");
      expect(get(entry, "facts", "nested", "inner")).toEqual(["[REDACTED]"]);
      expect(logText(where)).not.toMatch(/\btrue\b/);
    },
    timeout,
  );

  test(
    "R2.late-completion-observed: a write that completes after the freeze lands alone, and changes neither the frozen status nor the output",
    async () => {
      // The result exceeds the pipe buffer and stdout is held, so the CLI
      // waits in drain while the delayed write completes after the freeze.
      const where = tree();
      const script = { records: 2, dataBytes: 300_000 };
      const gate = join(where.root, "release-stdout");
      const launch = start({
        argv: read,
        tree: where,
        fault: "write-delays:900",
        script,
        holdStdoutUntil: gate,
      });
      const until = performance.now() + 30_000;
      while (!observe(where.dir).files.some((entry) => entry.size > 0)) {
        if (performance.now() > until) {
          release(gate);
          throw new Error("The late write never landed.");
        }
        await Bun.sleep(5);
      }
      release(gate);
      const result = await launch.finished;
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script });
      expect(
        result.stdout.split("\n").filter((line) => line.length > 0),
      ).toHaveLength(1);
      const status = statusOf(result);
      expectAvailable(status);
      expect(get(status, "sinkFailure")).toBe("flush-timeout");
      expect(get(status, "unflushedRecords")).toBe(2);
      expect(get(status, "closed")).toBe(false);
      // The in-flight record landed late; the second never started.
      const [log] = observe(where.dir).files;
      expect(lines(log?.path ?? "")).toHaveLength(1);
    },
    timeout,
  );

  test(
    "R2.cli-directory-symlink-refused: a <cli> directory redirected by a symlink is refused, nothing written there",
    async () => {
      const where = tree();
      mkdirSync(where.state, { mode: 0o700 });
      chmodSync(where.state, 0o700);
      const target = join(where.root, "redirected");
      mkdirSync(join(target, "diagnostics"), { recursive: true, mode: 0o700 });
      chmodSync(target, 0o700);
      chmodSync(join(target, "diagnostics"), 0o700);
      symlinkSync(target, join(where.state, "dxs"));
      const script = { records: 3, pace: true };
      const result = await run({ argv: read, tree: where, script });
      expectSuccess(result);
      await expectTwinEqual(result, { argv: read, script });
      const status = statusOf(result);
      expectAvailable(status);
      expect(get(status, "sinkFailure")).toBe("setup");
      expect(get(status, "file")).toBeNull();
      expect(observe(join(target, "diagnostics")).entries).toHaveLength(0);
    },
    timeout,
  );

  test(
    "R2.concurrent-first-runs-all-log: runs released together onto an empty state root all create their logs",
    async () => {
      // The D06 flake: the first batch of fixture runs raced to create the
      // directory tree, and a loser's EEXIST was disclosed as setup.
      const where = tree();
      const go = join(where.root, "go");
      const runs = Array.from({ length: 10 }, (_, index) => {
        const ready = join(where.root, `ready-${index}`);
        return {
          ready,
          launched: start({
            argv: read,
            tree: where,
            script: { records: 1, hold: { after: 0, ready, go } },
          }),
        };
      });
      for (const entry of runs) await waitForFile(entry.ready);
      release(go);
      for (const entry of runs) {
        const result = await entry.launched.finished;
        expectSuccess(result);
        const status = statusOf(result);
        expectAvailable(status);
        expect([
          get(status, "sinkFailure"),
          typeof get(status, "file"),
        ]).toEqual([null, "string"]);
      }
      expect(observe(where.dir).files).toHaveLength(10);
    },
    timeout,
  );
});
