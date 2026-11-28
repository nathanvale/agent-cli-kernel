import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  faultSeconds,
  faultsInShard,
  readTimings,
  shardIds,
  shardOf,
  type Shard,
  timingFile,
  timingsPath,
  unlistedSeconds,
  writeTiming,
} from "../../../scripts/planted-fault-shards.ts";
import { readRecords } from "../../../scripts/planted-faults.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";

const repository = join(import.meta.dir, "../../..");
const folder = ownedFolders();

function faultsNamed(...ids: readonly string[]) {
  return ids.map((id) => ({ id }));
}

function split(
  faults: readonly { id: string }[],
  timings: ReadonlyMap<string, number>,
  parts: number,
): string[][] {
  return Array.from({ length: parts }, (_, index) =>
    shardIds(faults, timings, { part: index + 1, parts }),
  );
}

function rootWithTimings(files: Readonly<Record<string, string>>): string {
  const root = folder("fault-shards-");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}

describe("shardIds", () => {
  test("puts every fault record in exactly one part, each part in record order", () => {
    const faults = Array.from({ length: 23 }, (_, index) => ({
      id: `f${index}`,
    }));
    const ids = faults.map(({ id }) => id);
    const timings = new Map([
      ["f3", 60],
      ["f7", 30],
      ["f11", 12.5],
      ["f20", 1],
    ]);
    for (const parts of [1, 2, 3, 4, 7, 23]) {
      const shards = split(faults, timings, parts);
      expect(shards.flat().toSorted()).toEqual(ids.toSorted());
      for (const shard of shards)
        expect(shard).toEqual(ids.filter((id) => shard.includes(id)));
    }
  });

  test("gives the heaviest measured faults their own parts, then fills the lightest part", () => {
    const faults = faultsNamed("a", "b", "c", "d");
    const timings = new Map([
      ["a", 60],
      ["b", 30],
      ["c", 20],
      ["d", 20],
    ]);
    expect(split(faults, timings, 2)).toEqual([["a"], ["b", "c", "d"]]);
    expect(split(faults, timings, 3)).toEqual([["a"], ["b"], ["c", "d"]]);
  });

  test("counts a fault the timings do not list at the hosted default of 1.7 s", () => {
    const faults = faultsNamed("measured", "u1", "u2", "u3", "u4");
    expect(split(faults, new Map([["measured", 5]]), 2)).toEqual([
      ["measured", "u4"],
      ["u1", "u2", "u3"],
    ]);
  });

  test("uses the stated default for a fault with no recorded time", () => {
    expect(unlistedSeconds).toBe(1.7);
    expect(faultSeconds("missing", new Map())).toBe(1.7);
    expect(faultSeconds("timed", new Map([["timed", 4.2]]))).toBe(4.2);
  });

  test("balances skewed timings within 25 percent instead of assigning in record order", () => {
    for (const entries of [
      [
        ["a", 40],
        ["b", 2],
        ["c", 40],
        ["d", 2],
      ],
      [
        ["a", 40],
        ["b", 40],
        ["c", 2],
        ["d", 2],
      ],
    ] as const) {
      const faults = faultsNamed(...entries.map(([id]) => id));
      const timings = new Map<string, number>(entries);
      const loads = split(faults, timings, 2).map((ids) =>
        ids.reduce((sum, id) => sum + faultSeconds(id, timings), 0),
      );
      expect(Math.max(...loads) / Math.min(...loads)).toBeLessThanOrEqual(1.25);
    }
  });

  test("keeps the four parts within 25 percent of each other on the repository's current records", () => {
    const records = readRecords(repository);
    const timings = readTimings(repository);
    const loads = split(records, timings, 4).map((ids) =>
      ids.reduce((sum, id) => sum + faultSeconds(id, timings), 0),
    );
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThanOrEqual(1.25);
  });
});

describe("writeTiming", () => {
  test("writes a fault's rounded positive seconds to its timing file for readTimings", () => {
    const root = folder("fault-shards-");
    writeTiming(root, "abc1234-example", 3.46);
    writeTiming(root, "fast-fault", 0.01);
    writeTiming(root, "zero-fault", 0);
    expect(Object.fromEntries(readTimings(root))).toEqual({
      "abc1234-example": 3.5,
      "fast-fault": 0.1,
      "zero-fault": 0.1,
    });
  });

  test("refuses a timing that is negative or not finite", () => {
    const root = folder("fault-shards-");
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => writeTiming(root, "bad-fault", seconds)).toThrow(
        `Timing for bad-fault is '${String(seconds)}'. Repair: pass a non-negative number of seconds.`,
      );
  });
});

describe("shardOf", () => {
  test("reads --shard <part>/<parts>", () => {
    const read: Shard[] = [
      shardOf(["--shard", "1/1"]),
      shardOf(["--shard", "2/4"]),
      shardOf(["--shard", "4/4"]),
    ];
    expect(read).toEqual([
      { part: 1, parts: 1 },
      { part: 2, parts: 4 },
      { part: 4, parts: 4 },
    ]);
  });

  test("reads the base after --tooling-changed-since", () => {
    expect(
      shardOf(["--shard", "3/4", "--tooling-changed-since", "origin/main"]),
    ).toEqual({ part: 3, parts: 4, toolingBase: "origin/main" });
    expect(shardOf(["--shard", "3/4"]).toolingBase).toBeUndefined();
  });

  test("refuses a part outside 1 to its parts, or anything else, naming what it got", () => {
    for (const argv of [
      ["--shard"],
      ["--shard", ""],
      ["--shard", "0/4"],
      ["--shard", "5/4"],
      ["--shard", "2/0"],
      ["--shard", "-1/4"],
      ["--shard", "1.5/4"],
      ["--shard", "2"],
      ["--shard", "2/4", "2/4"],
      ["--shard", "2/4", "--tooling-changed-since"],
      ["--shard", "2/4", "--tooling-changed-since", ""],
      ["--shard", "2/4", "--changed-since", "origin/main"],
      ["--shard", "2/4", "--tooling-changed-since", "origin/main", "HEAD"],
    ])
      expect(() => shardOf(argv)).toThrow(
        `Usage: bun run fault-replay --shard <part>/<parts> [--tooling-changed-since <base>] [--update-timings], with whole numbers 1 <= part <= parts. Got '${argv.join(" ")}'. Repair: pass one part, such as --shard 2/4.`,
      );
  });
});

describe("readTimings", () => {
  test("reads each fault's measured seconds from its own file", () => {
    const root = rootWithTimings({
      [timingFile("b")]: "60\n",
      [timingFile("a-b")]: "1.5\n",
      [timingFile("a")]: "2.5\n",
    });
    expect(Object.fromEntries(readTimings(root))).toEqual({
      a: 2.5,
      "a-b": 1.5,
      b: 60,
    });
  });

  test("reads a timing file added beside the others, with no list to update", () => {
    const root = rootWithTimings({ [timingFile("a")]: "2.5\n" });
    write(root, timingFile("c"), "4\n");
    expect(Object.fromEntries(readTimings(root))).toEqual({ a: 2.5, c: 4 });
  });

  test("reads no timings when the folder is absent", () => {
    expect([...readTimings(folder("fault-shards-"))]).toEqual([]);
  });

  test("skips the macOS .DS_Store file in the timings folder", () => {
    const root = rootWithTimings({
      [timingFile("a")]: "1\n",
      [`${timingsPath}/.DS_Store`]: "x",
    });
    expect([...readTimings(root)]).toEqual([["a", 1]]);
  });

  test("refuses a timing that is not a positive number, naming its file and the value", () => {
    for (const value of ["0", "-1", '"3"', "null", "{}", "not json", ""]) {
      const root = rootWithTimings({
        [timingFile("a")]: "1\n",
        [timingFile("b")]: `${value}\n`,
      });
      expect(() => readTimings(root)).toThrow(
        `${timingFile("b")} holds '${value}'. Repair: write one positive number of seconds, such as 1.5.`,
      );
    }
  });

  test("refuses a file in the timings folder that is not a .json timing, naming it", () => {
    for (const name of ["a.txt", ".a.json", "a.json/inner.json"]) {
      const root = rootWithTimings({ [`${timingsPath}/${name}`]: "1\n" });
      const refused = name.split("/")[0];
      expect(() => readTimings(root)).toThrow(
        `${timingsPath}/${refused} is not a fault timing file. Repair: keep each fault timing as a plain file named <id>.json, with no leading dot, and nothing else in ${timingsPath}.`,
      );
    }
  });

  test("refuses the old single list of timings, naming it", () => {
    const root = rootWithTimings({
      [timingFile("a")]: "1\n",
      "tests/planted-faults/fault-timings.json": '{ "b": 2 }\n',
    });
    expect(() => readTimings(root)).toThrow(
      "tests/planted-faults/fault-timings.json is the old single list of each fault timing, which nothing reads any more. Repair: move each entry in it to its own file, tests/planted-faults/fault-timings/<id>.json, then delete tests/planted-faults/fault-timings.json.",
    );
  });

  test("lists only ids that this repository's fault records hold", () => {
    const ids = new Set(readRecords(repository).map(({ id }) => id));
    const listed = [...readTimings(repository).keys()];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe("faultsInShard", () => {
  const kernel = (id: string) => ({
    id,
    testFile: `tests/kernel/${id}.test.ts`,
  });
  const tooling = (id: string) => ({
    id,
    testFile: `tests/template/names-check/${id}.test.ts`,
  });
  const mixed = [kernel("k1"), tooling("t1"), kernel("k2"), tooling("t2")];

  function selected(
    faults: readonly { id: string; testFile: string }[],
    argv: readonly string[],
    touched: readonly string[] = [],
  ) {
    const asked: string[][] = [];
    const root = folder("fault-shards-");
    const ids = faultsInShard(
      root,
      argv,
      (given) => (given === root ? faults : []),
      (given, base) => {
        asked.push([given === root ? "root" : given, base]);
        return touched;
      },
    );
    return { ids, asked };
  }

  test("returns the ids of the part it names, every fault record counted", () => {
    expect(selected(mixed, ["--shard", "2/2"])).toEqual({
      ids: ["t1", "t2"],
      asked: [],
    });
    expect(selected(mixed, ["--shard", "1/1"]).ids).toEqual([
      "k1",
      "t1",
      "k2",
      "t2",
    ]);
  });

  test("with --tooling-changed-since keeps every other fault but only the tooling faults touched since the base", () => {
    expect(
      selected(
        mixed,
        ["--shard", "1/1", "--tooling-changed-since", "origin/main"],
        ["t2", "k1"],
      ),
    ).toEqual({ ids: ["k1", "k2", "t2"], asked: [["root", "origin/main"]] });
    expect(
      selected(
        mixed,
        ["--shard", "1/1", "--tooling-changed-since", "origin/main"],
        [],
      ).ids,
    ).toEqual(["k1", "k2"]);
  });

  test("refuses a part that would hold none of the selected fault records, so it never checks nothing", () => {
    expect(() => selected(mixed.slice(0, 2), ["--shard", "3/3"])).toThrow(
      "Part 3 of 3 holds none of the 2 selected fault records, so it checks nothing. Repair: pass fewer parts.",
    );
    expect(() =>
      selected(
        [tooling("t1")],
        ["--shard", "1/1", "--tooling-changed-since", "HEAD"],
      ),
    ).toThrow(
      "Part 1 of 1 holds none of the 0 selected fault records, so it checks nothing. Repair: pass fewer parts.",
    );
    expect(selected(mixed.slice(0, 2), ["--shard", "2/2"]).ids).toEqual(["t1"]);
  });

  test("returns no id when there is no fault record, leaving replay to refuse the empty records", () => {
    expect(selected([], ["--shard", "1/4"]).ids).toEqual([]);
  });
});
