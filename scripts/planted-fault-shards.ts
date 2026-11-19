import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quoted } from "./planted-fault-patch.ts";

export type Shard = { readonly part: number; readonly parts: number };
export type Recorded = { readonly id: string };

const timingsPath = "tests/planted-faults/fault-timings.json";
const unlistedSeconds = 0.35;
const shardPattern = /^(?<part>[1-9]\d*)\/(?<parts>[1-9]\d*)$/;

export function shardOf(argv: readonly string[]): Shard {
  const [, given, ...extra] = argv;
  const found = shardPattern.exec(given ?? "")?.groups;
  const part = Number(found?.part);
  const parts = Number(found?.parts);
  if (found === undefined || part > parts || extra.length > 0)
    throw new Error(
      `Usage: bun run fault-replay --shard <part>/<parts>, with whole numbers 1 <= part <= parts. Got ${quoted(argv.join(" "))}. Repair: pass one part, such as --shard 2/4.`,
    );
  return { part, parts };
}

export function readTimings(root: string): ReadonlyMap<string, number> {
  const path = join(root, timingsPath);
  if (!existsSync(path)) return new Map();
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(
      `${timingsPath} must hold one JSON object of fault ids and seconds. Repair: make its top level an object, such as { "<id>": 1.5 }.`,
    );
  const timings = new Map<string, number>();
  for (const [id, seconds] of Object.entries(parsed)) {
    if (typeof seconds !== "number" || !(seconds > 0))
      throw new Error(
        `${timingsPath} gives ${id} ${JSON.stringify(seconds)}. Repair: give each fault id a positive number of seconds.`,
      );
    timings.set(id, seconds);
  }
  return timings;
}

export function shardIds(
  faults: readonly Recorded[],
  timings: ReadonlyMap<string, number>,
  { part, parts }: Shard,
): string[] {
  const heaviestFirst = faults
    .map(({ id }, index) => ({
      id,
      index,
      seconds: timings.get(id) ?? unlistedSeconds,
    }))
    .toSorted((a, b) => b.seconds - a.seconds || a.index - b.index);
  const loads = Array.from({ length: parts }, () => 0);
  const partOf = new Map<string, number>();
  for (const { id, seconds } of heaviestFirst) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] = (loads[lightest] ?? 0) + seconds;
    partOf.set(id, lightest + 1);
  }
  return faults.filter(({ id }) => partOf.get(id) === part).map(({ id }) => id);
}

export function faultsInShard(
  root: string,
  faults: readonly Recorded[],
  argv: readonly string[],
): string[] {
  const shard = shardOf(argv);
  const ids = shardIds(faults, readTimings(root), shard);
  if (ids.length === 0 && faults.length > 0)
    throw new Error(
      `Part ${shard.part} of ${shard.parts} holds no fault record, so it checks nothing. Repair: pass at most ${faults.length} parts.`,
    );
  return ids;
}
