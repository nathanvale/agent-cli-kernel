import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunSpawn, defaultLimits } from "../../../skills/verify-cli/verify.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
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

describe("the check's own bounds", () => {
  test(
    "an envelope over 64 KiB reaches a slow reader whole",
    async () => {
      const at = world();
      const ran = await spawnBounded(
        [
          "sh",
          "-c",
          '"$0" "$1" findings "$2" --json | (sleep 0.5; cat)',
          process.execPath,
          checkEntry,
          fixture(at, "loud-cli.ts"),
        ],
        { cwd: at.repo, env: at.env, boundMilliseconds: checkBound },
      );
      expect(ran.stdout.length).toBeGreaterThan(65_536);
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
});
