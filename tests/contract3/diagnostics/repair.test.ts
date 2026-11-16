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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
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
      // Inside the 500 ms flush bound, with 150 ms for process noise.
      expect(
        result.elapsedMilliseconds - intact.elapsedMilliseconds,
      ).toBeLessThanOrEqual(500 + 150);
    },
    timeout,
  );
});

describe("SF5 a late write at the process layer", () => {
  test(
    "R1.late-completion-process: a write still pending at the freeze never lands and starts no second output",
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
