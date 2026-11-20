import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { at } from "./json.ts";

export const cli = "verify-agent-cli";

export type Environment = Readonly<Record<string, string | undefined>>;

export function verificationFolder(environment: Environment): string {
  const state = environment.XDG_STATE_HOME;
  const home = environment.HOME;
  if (state !== undefined && isAbsolute(state)) return join(state, cli);
  if (home !== undefined && isAbsolute(home))
    return join(home, ".local", "state", cli);
  throw new Error(
    `${cli} needs XDG_STATE_HOME or HOME as an absolute path, to place its runs. Repair: set HOME, or XDG_STATE_HOME, to an absolute folder.`,
  );
}

export type RunPlace = {
  readonly run: string;
  readonly folder: string;
  readonly scratch: string;
  readonly home: string;
  readonly evidence: string;
  readonly record: string;
};

export function runPlace(root: string, run: string): RunPlace {
  const folder = join(root, "runs", run);
  const scratch = join(folder, "scratch");
  const evidence = join(folder, "evidence");
  return {
    run,
    folder,
    scratch,
    home: join(scratch, "home"),
    evidence,
    record: join(evidence, "run.json"),
  };
}

export type RunRecord = {
  readonly run: string;
  readonly repository: string;
  readonly entry: string;
  readonly launchedAt: string;
};

function field(value: unknown, name: string): string | undefined {
  const found = at(value, name);
  return typeof found === "string" ? found : undefined;
}

export function readRunRecord(place: RunPlace): RunRecord | undefined {
  if (!existsSync(place.record)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(place.record, "utf8"));
  const repository = field(parsed, "repository");
  const entry = field(parsed, "entry");
  const launchedAt = field(parsed, "launchedAt");
  if (
    field(parsed, "run") !== place.run ||
    repository === undefined ||
    entry === undefined ||
    launchedAt === undefined
  )
    throw new Error(
      `${place.record} is not a run record this helper wrote. Repair: launch a new run under another name.`,
    );
  return { run: place.run, repository, entry, launchedAt };
}

const defaultEntry = "src/cli.ts";

export function entryFor(
  given: string | undefined,
  record: RunRecord | undefined,
  cwd: string,
): string {
  const entry = given ?? record?.entry ?? defaultEntry;
  return isAbsolute(entry) ? entry : join(cwd, entry);
}
