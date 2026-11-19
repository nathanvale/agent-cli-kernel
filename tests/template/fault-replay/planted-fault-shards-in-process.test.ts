import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  faultsInShard,
  readTimings,
  shardIds,
  shardOf,
  type Shard,
} from "../../../scripts/planted-fault-shards.ts";
import { readRecords } from "../../../scripts/planted-faults.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";

const repository = join(import.meta.dir, "../../..");
const timingsPath = "tests/planted-faults/fault-timings.json";
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

function rootWithTimings(text: string): string {
  const root = folder("fault-shards-");
  write(root, timingsPath, text);
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

  test("counts a fault the timings do not list as more than a third and less than half a second", () => {
    const faults = faultsNamed("measured", "u1", "u2", "u3", "u4");
    expect(split(faults, new Map([["measured", 1]]), 2)).toEqual([
      ["measured", "u4"],
      ["u1", "u2", "u3"],
    ]);
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
    ])
      expect(() => shardOf(argv)).toThrow(
        `Usage: bun run fault-replay --shard <part>/<parts>, with whole numbers 1 <= part <= parts. Got '${argv.join(" ")}'. Repair: pass one part, such as --shard 2/4.`,
      );
  });
});

describe("readTimings", () => {
  test("reads each fault's measured seconds", () => {
    const root = rootWithTimings('{ "a": 2.5, "b": 60 }\n');
    expect([...readTimings(root)]).toEqual([
      ["a", 2.5],
      ["b", 60],
    ]);
  });

  test("reads no timings when the file is absent", () => {
    expect([...readTimings(folder("fault-shards-"))]).toEqual([]);
  });

  test("refuses a timing that is not a positive number, naming the fault and the value", () => {
    for (const value of ["0", "-1", '"3"', "null"]) {
      const root = rootWithTimings(`{ "a": 1, "b": ${value} }\n`);
      expect(() => readTimings(root)).toThrow(
        `${timingsPath} gives b ${value}. Repair: give each fault id a positive number of seconds.`,
      );
    }
  });

  test("refuses a file that is not one JSON object", () => {
    for (const text of ["[]\n", "1\n", "null\n"])
      expect(() => readTimings(rootWithTimings(text))).toThrow(
        `${timingsPath} must hold one JSON object of fault ids and seconds. Repair: make its top level an object, such as { "<id>": 1.5 }.`,
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
  test("returns the ids of the part it names", () => {
    const root = folder("fault-shards-");
    expect(
      faultsInShard(root, faultsNamed("a", "b", "c"), ["--shard", "2/2"]),
    ).toEqual(["b"]);
  });

  test("refuses a part that would hold no fault record, so it never checks nothing", () => {
    const root = folder("fault-shards-");
    expect(() =>
      faultsInShard(root, faultsNamed("a", "b"), ["--shard", "3/3"]),
    ).toThrow(
      "Part 3 of 3 holds no fault record, so it checks nothing. Repair: pass at most 2 parts.",
    );
    expect(
      faultsInShard(root, faultsNamed("a", "b"), ["--shard", "2/2"]),
    ).toEqual(["b"]);
  });

  test("returns no id when there is no fault record, leaving replay to refuse the empty records", () => {
    expect(
      faultsInShard(folder("fault-shards-"), [], ["--shard", "1/4"]),
    ).toEqual([]);
  });
});
