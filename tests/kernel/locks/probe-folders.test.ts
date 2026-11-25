import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  processWatchdog,
  spawnBounded,
} from "../kernel-repair/swarm-process.ts";
import { readRun } from "./lock-probes.ts";

const root = realpathSync(resolve(import.meta.dir, "../../.."));
const probes = "./tests/kernel/locks/lock-probes.test.ts";
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

test(
  "a lock probe reached through a symbolic link matches its sentinel and diagnostics",
  async () => {
    const outer = folder("locks-probe-link-");
    const real = join(outer, "real");
    const link = join(outer, "link");
    mkdirSync(join(real, "locks"), { recursive: true });
    symlinkSync(real, link);

    const files = ["locks/probe-0.ts", "locks/probe-1.ts"];
    const errorPath = relative(root, join(real, "locks/probe-0.ts"));
    const sentinelPath = relative(root, join(real, "locks/sentinel.ts"));
    const read = readRun("native", link, files, {
      stdout: `${errorPath}(1,7): error TS2322: planted.\n${sentinelPath}(1,14): error TS2322: sentinel.\n`,
      stderr: "",
      exit: 2,
    });
    expect(read.settled.get("locks/probe-0.ts")).toMatchObject({ exit: 2 });
    expect(read.settled.get("locks/probe-1.ts")).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
      diagnostics: [],
    });

    const repoLink = join(outer, "nested", "repo");
    mkdirSync(join(outer, "nested"), { recursive: true });
    symlinkSync(root, repoLink);
    const run = await spawnBounded(
      [
        process.execPath,
        "test",
        probes,
        "-t",
        "a type error in a file the probes import fails only the probes that import it",
      ],
      {
        cwd: repoLink,
        env: {
          ...process.env,
          PWD: repoLink,
          TMPDIR: link,
          STATE_TEST_DIR: link,
        },
        processGroup: true,
      },
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(" 1 pass");
  },
  processWatchdog(1),
);
