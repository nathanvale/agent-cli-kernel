import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bunSpawn,
  defaultLimits,
  forwardStops,
} from "../../../skills/verify-cli/verify.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { goneWithin } from "../lifecycle/harness.ts";
import {
  checkBound,
  checkEntry,
  field,
  fixture,
  fixtures,
  helperBound,
  ledgeredPid,
  parsed,
  releaseWorlds,
  watchdog,
  world,
} from "./harness.ts";

afterAll(releaseWorlds);

// Platform: a pipe holds 65,536 bytes on macOS and on Linux (pipe(7)), so a
// check that exits before its write drains leaves at most this much behind.
const pipeCapacity = 65_536;
const readAfterCheckWaitsOrExits =
  'mkfifo "$4" && "$0" --preload "$3" "$1" findings "$2" --json 3>"$4" | { read -r _ <"$4"; cat; }';

describe("the check's own bounds", () => {
  test(
    "an envelope over 64 KiB reaches a slow reader whole",
    async () => {
      const at = world();
      const ran = await spawnBounded(
        [
          "sh",
          "-c",
          readAfterCheckWaitsOrExits,
          process.execPath,
          checkEntry,
          fixture(at, "loud-cli.ts"),
          fixture(at, "stdout-wait-preload.ts"),
          join(at.folder, "check-waiting"),
        ],
        {
          cwd: at.repo,
          env: at.env,
          boundMilliseconds: checkBound,
          processGroup: true,
        },
      );
      expect(ran.stdout.length).toBeGreaterThan(pipeCapacity);
      const findings = field(parsed(ran.stdout), "result", "data", "findings");
      expect(Array.isArray(findings) ? findings.length : 0).toBeGreaterThan(0);
    },
    watchdog(0, 1),
  );

  test(
    "a child's output is kept up to the check's output limit",
    async () => {
      const ran = await bunSpawn(process.env, {
        ...defaultLimits,
        outputBytes: 10,
      })(
        ["-e", "process.stdout.write('x'.repeat(100))"],
        fixtures,
        helperBound,
      );
      expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({
        exitCode: 0,
        stdout: "x".repeat(10),
      });
    },
    watchdog(1),
  );

  test(
    "a pipe a grandchild holds open is let go once the grace after the child's end runs out",
    async () => {
      const at = world();
      const ledger = join(at.folder, "holder-ledger");
      const started = performance.now();
      try {
        const ran = await bunSpawn(at.env, {
          ...defaultLimits,
          graceMilliseconds: 300,
        })([join(fixtures, "holder-cli.ts"), ledger], fixtures, helperBound);
        expect({ exitCode: ran.exitCode, timedOut: ran.timedOut }).toEqual({
          exitCode: 0,
          timedOut: false,
        });
        expect(performance.now() - started).toBeLessThan(10_000);
      } finally {
        process.kill(ledgeredPid(ledger), "SIGKILL");
      }
    },
    watchdog(1),
  );

  test(
    "a child's stdin is closed to it, never the check's own",
    async () => {
      const driver = Bun.spawn(
        [process.execPath, join(fixtures, "stdin-cli.ts")],
        { cwd: fixtures, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => driver.kill("SIGKILL"), helperBound);
      const stdout = await new Response(driver.stdout).text();
      await driver.exited;
      clearTimeout(timer);
      expect(stdout).toBe("device");
    },
    watchdog(1),
  );

  test(
    "a child that runs past its limit is stopped with the processes it started",
    async () => {
      const at = world();
      const ledger = join(at.folder, "hanging-ledger");
      const ran = await bunSpawn(at.env, {
        ...defaultLimits,
        graceMilliseconds: 300,
      })([join(fixtures, "hanging-cli.ts"), ledger], fixtures, 1_000);
      const pid = ledgeredPid(ledger);
      const gone = await goneWithin(pid, 2_000);
      if (!gone) process.kill(pid, "SIGKILL");
      expect({ timedOut: ran.timedOut, gone }).toEqual({
        timedOut: true,
        gone: true,
      });
    },
    watchdog(1),
  );

  test(
    "a stop signal ends each child at once, and kills it when the grace runs out",
    async () => {
      const at = world();
      const ledger = join(at.folder, "stop-ledger");
      const ran = await spawnBounded(
        [process.execPath, join(fixtures, "stop-cli.ts"), ledger],
        { cwd: fixtures, env: at.env, boundMilliseconds: helperBound },
      );
      const seen = parsed(ran.stdout);
      expect(field(seen, "signal")).toBe("SIGKILL");
      expect(Number(field(seen, "milliseconds"))).toBeLessThan(5_000);
    },
    watchdog(1),
  );

  test("the check listens for SIGTERM and SIGINT, and for nothing else", () => {
    const heard: string[] = [];
    forwardStops(defaultLimits, (signal) => heard.push(signal));
    expect(heard).toEqual(["SIGTERM", "SIGINT"]);
  });
});
