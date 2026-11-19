import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  processWatchdog,
  spawnBounded,
} from "../kernel-repair/swarm-process.ts";

const repository = join(import.meta.dir, "..", "..", "..");
const probe = "tests/kernel/state/linux-coordination.probe.test.ts";
const ledgerPreload = join(
  import.meta.dir,
  "fixtures",
  "probe-folder-ledger.ts",
);
const folder = ownedFolders();

function probePlaces(root: string): string[] {
  return [
    join(root, dirname(probe), ".probe-tmp"),
    join(root, "tmp"),
    ...(existsSync("/dev/shm") ? ["/dev/shm"] : []),
  ];
}

async function probeRun(root: string, filter: string) {
  for (const path of [probe, "tests/support/signal.ts"])
    write(root, path, readFileSync(join(repository, path), "utf8"));
  mkdirSync(join(root, "tmp"));
  const ledger = join(root, "made-folders");
  const made = () =>
    existsSync(ledger)
      ? readFileSync(ledger, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];
  try {
    const run = await spawnBounded(
      [
        process.execPath,
        "test",
        "--preload",
        ledgerPreload,
        `./${probe}`,
        "-t",
        filter,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: join(root, "tmp"),
          PROBE_DIR: undefined,
          PROBE_FOLDER_LEDGER: ledger,
        },
      },
    );
    return {
      exit: run.exit,
      made: made(),
      left: made().filter((path) => existsSync(path)),
    };
  } finally {
    for (const path of made()) rmSync(path, { recursive: true, force: true });
  }
}

test(
  "a linux coordination probe run leaves no probe folder when its filter matches some of its tests or none",
  async () => {
    const someRoot = folder("linux-coordination-probe-some-");
    const some = await probeRun(someRoot, "PROBE environment");
    expect(some.exit).toBe(0);
    expect(
      probePlaces(someRoot).filter(
        (place) => !some.made.some((path) => dirname(path) === place),
      ),
    ).toEqual([]);
    expect(some.left).toEqual([]);

    const none = await probeRun(
      folder("linux-coordination-probe-none-"),
      "no linux coordination probe test has this title",
    );
    expect(none.left).toEqual([]);
  },
  processWatchdog(2),
);
