import { readFileSync } from "node:fs";
import { join } from "node:path";
import { field, parsed, repository } from "../verify-skill/harness.ts";

export const recordPath = "tests/kernel/self-verification/stations.json";

const states = ["swept", "driven", "owed"] as const;
export type StationState = (typeof states)[number];

export type Station = {
  readonly command: string;
  readonly cause: string;
  readonly state: StationState;
};

export type StationRecord = {
  readonly checks: number | undefined;
  readonly stations: ReadonlyMap<string, StationState>;
  readonly failures: readonly string[];
};

const stationKey = (station: { command: string; cause: string }) =>
  `${station.command} ${station.cause}`;

export function stationOf(
  value: unknown,
  state?: unknown,
): Station | undefined {
  const command = field(value, "command");
  const cause = field(value, "cause");
  const given = state ?? field(value, "state");
  const known = states.find((each) => each === given);
  return typeof command === "string" &&
    typeof cause === "string" &&
    known !== undefined
    ? { command, cause, state: known }
    : undefined;
}

export function readRecord(): unknown {
  return parsed(readFileSync(join(repository, recordPath), "utf8"));
}

export function recordedNames(record: unknown): readonly string[] {
  return typeof record === "object" && record !== null
    ? Object.keys(record)
    : [];
}

export function recordOf(name: string, record: unknown): StationRecord {
  const listed = field(record, name, "stations");
  const checks = field(record, name, "checks");
  const entries = Array.isArray(listed)
    ? listed.map((each) => stationOf(each))
    : [];
  const stations = new Map<string, StationState>();
  const failures: string[] = [];
  if (!Array.isArray(listed) || entries.includes(undefined))
    failures.push(
      `${name}: ${recordPath} holds no "stations" list of { command, cause, state } entries for this CLI, each state one of ${states.join(", ")}. Repair: give "${name}" the stations its self-verification run reaches.`,
    );
  for (const entry of entries) {
    if (entry === undefined) continue;
    if (stations.has(stationKey(entry)))
      failures.push(
        `${name}: ${recordPath} lists ${stationKey(entry)} twice. Repair: keep one entry for it.`,
      );
    stations.set(stationKey(entry), entry.state);
  }
  if (checks !== undefined && !Number.isSafeInteger(checks))
    failures.push(
      `${name}: ${recordPath} gives "checks" as ${JSON.stringify(checks)}. Repair: give the whole number of checks the sweep runs, or leave it out.`,
    );
  return {
    checks: typeof checks === "number" ? checks : undefined,
    stations,
    failures,
  };
}

export function stationFailures(
  name: string,
  observed: readonly Station[],
  record: StationRecord,
): string[] {
  const seen = new Map(observed.map((each) => [stationKey(each), each.state]));
  const failures: string[] = [];
  for (const [key, state] of seen) {
    const recorded = record.stations.get(key);
    if (recorded === undefined)
      failures.push(
        `${name}: ${key} is ${state} and ${recordPath} does not list it. Repair: ${state === "owed" ? "drive it with a --json step in a scenario; if no scenario can reach it yet, add it" : "if the station is new on purpose, add it"} to "${name}" with state "${state}".`,
      );
    else if (recorded !== state)
      failures.push(
        `${name}: ${key} is ${state}, and ${recordPath} lists it as ${recorded}. Repair: restore what made it ${recorded}; if the change is on purpose, set its state to "${state}".`,
      );
  }
  for (const [key, state] of record.stations)
    if (!seen.has(key))
      failures.push(
        `${name}: ${recordPath} lists ${key} as ${state}, and the run reached no such station. Repair: restore the command or station; if it was removed on purpose, remove the entry from "${name}".`,
      );
  return failures;
}
