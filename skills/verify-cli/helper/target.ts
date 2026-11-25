import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { at, listOf, parsedJson } from "./json.ts";
import { targetArgs, targetLimits } from "./place.ts";

export type Ran = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type TargetRunner = (argv: readonly string[]) => Promise<Ran>;

export function targetRunner(
  programs: Pick<ProgramsCapability, "supplied">,
  bun: ParsedPath,
  entry: string,
): TargetRunner {
  return async (argv) => {
    const ran = await programs.supplied({
      executable: bun,
      args: [...targetArgs(entry, argv)],
      ...targetLimits,
    });
    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr };
  };
}

export function envelopeOf(stdout: string): unknown {
  const lines = stdout.split("\n");
  if (lines.length !== 2 || lines[1] !== "") return null;
  const parsed = parsedJson(lines[0] ?? "");
  return typeof at(parsed, "contractVersion") === "string" &&
    typeof at(parsed, "result", "exitCode") === "number" &&
    typeof at(parsed, "result", "commandIdentity") === "string" &&
    typeof at(parsed, "result", "causeCode") === "string"
    ? parsed
    : null;
}

export function stringAt(value: unknown, ...names: readonly string[]) {
  const found = at(value, ...names);
  return typeof found === "string" ? found : null;
}

export type Listed = {
  readonly identity: string;
  readonly route: readonly string[];
  readonly effectClass: string;
};

function listed(entry: unknown): Listed | undefined {
  const identity = stringAt(entry, "commandIdentity");
  const effectClass = stringAt(entry, "effectClass");
  const route = listOf(at(entry, "route"));
  if (
    identity === null ||
    effectClass === null ||
    !route.every((word) => typeof word === "string")
  )
    return undefined;
  return { identity, route: route.map(String), effectClass };
}

const kernelCommands = [
  "help",
  "discovery",
  "full-discovery",
  "command-discovery",
  "dispatch",
] as const;

export type Commands = {
  readonly cli: string | null;
  readonly own: readonly Listed[];
};

export function ownCommands(discovery: unknown): Commands {
  const all = listOf(at(discovery, "result", "data", "commands"))
    .map((entry) => listed(entry))
    .filter((entry) => entry !== undefined);
  const help = all.find(
    (entry) => entry.route.length === 1 && entry.route[0] === "--help",
  );
  const cli =
    help !== undefined && help.identity.endsWith(".help")
      ? help.identity.slice(0, -".help".length)
      : null;
  const added = new Set(kernelCommands.map((name) => `${cli ?? ""}.${name}`));
  return {
    cli,
    own: cli === null ? [] : all.filter((entry) => !added.has(entry.identity)),
  };
}

export function kernelAdded(cause: string, trigger: string): boolean {
  return trigger === `Kernel ${cause}.`;
}
