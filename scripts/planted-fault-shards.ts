export type Shard = { readonly part: number; readonly parts: number };

export type Recorded = { readonly id: string };

function unbuilt(name: string): never {
  throw new Error(`${name} is not built yet.`);
}

export function shardOf(argv: readonly string[]): Shard {
  return unbuilt(`shardOf ${argv.join(" ")}`);
}

export function readTimings(root: string): ReadonlyMap<string, number> {
  return unbuilt(`readTimings ${root}`);
}

export function shardIds(
  faults: readonly Recorded[],
  timings: ReadonlyMap<string, number>,
  { part, parts }: Shard,
): string[] {
  return unbuilt(`shardIds ${faults.length} ${timings.size} ${part}/${parts}`);
}

export function faultsInShard(
  root: string,
  faults: readonly Recorded[],
  argv: readonly string[],
): string[] {
  return shardIds(faults, readTimings(root), shardOf(argv));
}
