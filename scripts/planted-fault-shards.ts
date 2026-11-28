import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { folderFiles } from "./planted-fault-folders.ts";
import { quoted } from "./planted-fault-patch.ts";

export type Shard = { readonly part: number; readonly parts: number };
export type Selection = Shard & { readonly toolingBase: string | undefined };
export type Recorded = { readonly id: string; readonly testFile: string };

export const timingsPath = "tests/planted-faults/fault-timings";
const timingExtension = ".json";
export const unlistedSeconds = 1.7;
const minimumRecordedSeconds = 0.1;
const toolingTests = "tests/template/";
const toolingOption = "--tooling-changed-since";
export const updateTimingsOption = "--update-timings";
const updateTimingsPrefix = `${updateTimingsOption}=`;
const shardPattern = /^(?<part>[1-9]\d*)\/(?<parts>[1-9]\d*)$/;

export function extractUpdateTimings(argv: readonly string[]): {
  readonly updateTimings: boolean;
  readonly timingsFolder: string | undefined;
  readonly args: string[];
} {
  const matches = (arg: string): boolean =>
    arg === updateTimingsOption ||
    (arg.startsWith(updateTimingsPrefix) &&
      arg.length > updateTimingsPrefix.length);
  const found = argv.find(matches);
  const updateTimings = found !== undefined;
  const timingsFolder =
    found?.startsWith(updateTimingsPrefix) === true
      ? found.slice(updateTimingsPrefix.length)
      : undefined;
  return {
    updateTimings,
    timingsFolder,
    args: updateTimings ? argv.filter((arg) => !matches(arg)) : [...argv],
  };
}

export function timingFile(id: string): string {
  return `${timingsPath}/${id}${timingExtension}`;
}

export function faultSeconds(
  id: string,
  timings: ReadonlyMap<string, number>,
): number {
  return timings.get(id) ?? unlistedSeconds;
}

export function writeTiming(
  root: string,
  id: string,
  seconds: number,
  folder: string = timingsPath,
): void {
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new Error(
      `Timing for ${id} is ${quoted(String(seconds))}. Repair: pass a non-negative number of seconds.`,
    );
  const rounded = Math.max(
    minimumRecordedSeconds,
    Math.round(seconds * 10) / 10,
  );
  const directory = resolve(root, folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${id}${timingExtension}`),
    `${JSON.stringify(rounded)}\n`,
  );
}

export function shardOf(argv: readonly string[]): Selection {
  const [, given, option, toolingBase, ...extra] = argv;
  const found = shardPattern.exec(given ?? "")?.groups;
  const part = Number(found?.part);
  const parts = Number(found?.parts);
  const toolingRead =
    option === undefined ||
    (option === toolingOption && (toolingBase ?? "") !== "");
  if (found === undefined || part > parts || !toolingRead || extra.length > 0)
    throw new Error(
      `Usage: bun run fault-replay --shard <part>/<parts> [${toolingOption} <base>] [${updateTimingsOption}], with whole numbers 1 <= part <= parts. Got ${quoted(argv.join(" "))}. Repair: pass one part, such as --shard 2/4.`,
    );
  return { part, parts, toolingBase };
}

function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readTiming(where: string, text: string): number {
  const seconds = jsonIn(text);
  if (typeof seconds !== "number" || !(seconds > 0))
    throw new Error(
      `${where} holds ${quoted(text.trim())}. Repair: write one positive number of seconds, such as 1.5.`,
    );
  return seconds;
}

export function readTimings(root: string): ReadonlyMap<string, number> {
  return new Map(
    folderFiles(root, timingsPath, "fault timing").map(({ file, id, text }) => [
      id,
      readTiming(file, text),
    ]),
  );
}

export function shardIds(
  faults: readonly { readonly id: string }[],
  timings: ReadonlyMap<string, number>,
  { part, parts }: Shard,
): string[] {
  const heaviestFirst = faults
    .map(({ id }, index) => ({
      id,
      index,
      seconds: faultSeconds(id, timings),
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
  argv: readonly string[],
  records: (root: string) => readonly Recorded[],
  touchedSince: (root: string, base: string) => readonly string[],
): string[] {
  const { toolingBase, ...shard } = shardOf(argv);
  const faults = records(root);
  const touched = new Set(
    toolingBase === undefined ? [] : touchedSince(root, toolingBase),
  );
  const selected = faults.filter(
    ({ id, testFile }) =>
      toolingBase === undefined ||
      !testFile.startsWith(toolingTests) ||
      touched.has(id),
  );
  const ids = shardIds(selected, readTimings(root), shard);
  if (ids.length === 0 && faults.length > 0)
    throw new Error(
      `Part ${shard.part} of ${shard.parts} holds none of the ${selected.length} selected fault records, so it checks nothing. Repair: pass fewer parts.`,
    );
  return ids;
}
