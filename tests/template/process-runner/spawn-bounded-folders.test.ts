import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { spawnBounded } from "../../support/process.ts";

const root = resolve(import.meta.dir, "../../..");
const file = "./tests/template/process-runner/spawn-bounded.test.ts";
const folder = ownedFolders();
const childBound = 60_000;

async function spawnBoundedRun(filter?: string) {
  const temporary = folder("spawn-bounded-folders-");
  const run = await spawnBounded(
    [process.execPath, "test", file, ...(filter ? ["-t", filter] : [])],
    {
      cwd: root,
      env: { ...process.env, TMPDIR: temporary, STATE_TEST_DIR: undefined },
      boundMilliseconds: childBound,
    },
  );
  return {
    ...run,
    left: readdirSync(temporary).filter((name) =>
      name.startsWith("spawn-bounded-no-ps-"),
    ),
  };
}

test(
  "a spawn-bounded run leaves no empty PATH folder in the temp folder, whole or filtered to the no-ps case",
  async () => {
    const whole = await spawnBoundedRun();
    expect(whole.exit).toBe(0);
    expect(whole.left).toEqual([]);

    const noPs = await spawnBoundedRun("ps cannot start");
    expect(noPs.stderr).toContain(" 1 pass");
    expect(noPs.exit).toBe(0);
    expect(noPs.left).toEqual([]);
  },
  2 * childBound + 10_000,
);
