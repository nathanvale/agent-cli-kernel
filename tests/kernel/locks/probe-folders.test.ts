import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  processWatchdog,
  spawnBounded,
} from "../kernel-repair/swarm-process.ts";

const root = resolve(import.meta.dir, "../../..");
const probes = "./tests/kernel/locks/probes.test.ts";
const folder = ownedFolders();

async function probesRun(filter: string) {
  const temporary = folder("locks-probe-folders-");
  const run = await spawnBounded(
    [process.execPath, "test", probes, "-t", filter],
    {
      cwd: root,
      env: { ...process.env, TMPDIR: temporary, STATE_TEST_DIR: undefined },
      processGroup: true,
    },
  );
  return {
    ...run,
    left: readdirSync(temporary).filter((name) =>
      name.startsWith("kernel-probes-"),
    ),
  };
}

test(
  "a locks probe run leaves no folder in the temp folder when its filter matches some of its tests or none",
  async () => {
    const none = await probesRun("no locks probe test has this title");
    expect(none.stderr).toMatch(/matched 0 tests\. .*skipping [1-9]\d* tests/);
    expect(none.left).toEqual([]);

    const some = await probesRun(
      "a type error in a file the probes import fails only the probes that import it",
    );
    expect(some.stderr).toContain(" 1 pass");
    expect(some.exit).toBe(0);
    expect(some.left).toEqual([]);
  },
  processWatchdog(2),
);
