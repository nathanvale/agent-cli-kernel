import { afterAll, describe, expect, test } from "bun:test";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  checkBound,
  checkEntry,
  field,
  fixture,
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
});
