import { readFileSync } from "node:fs";
import { join } from "node:path";
import { field, parsed, repository } from "../verify-skill/harness.ts";

export const recordPath = "tests/kernel/self-verification/owed-results.json";
export const featurePath = "skills/verify-cli/features/read-only-command.md";
const checkLine = "bun skills/verify-cli/verify.ts";

export type Ran = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type OwnCliRun = { readonly command: string; readonly ran: Ran };

export type OwnCli = {
  readonly name: string;
  readonly entry: string;
  readonly runs: readonly OwnCliRun[];
};

type OwedResult = { readonly command: string; readonly cause: string };

const key = (owed: OwedResult) => `${owed.command} ${owed.cause}`;

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function owedResult(value: unknown): OwedResult | undefined {
  const command = field(value, "command");
  const cause = field(value, "cause");
  return typeof command === "string" && typeof cause === "string"
    ? { command, cause }
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

export function featureScenario(markdown: string): unknown {
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)];
  if (blocks.length !== 1)
    throw new Error(
      `${featurePath} shows ${String(blocks.length)} scenario blocks. Repair: keep exactly one json block there, the scenario self-verification drives.`,
    );
  return parsed(blocks[0]?.[1] ?? "");
}

function recordFailures(
  name: string,
  record: unknown,
): { readonly expected: readonly OwedResult[]; readonly failures: string[] } {
  const listed = field(record, name);
  const expected = listOf(listed).map(owedResult);
  const kept = expected.filter((entry) => entry !== undefined);
  if (!Array.isArray(listed) || kept.length !== expected.length)
    return {
      expected: kept,
      failures: [
        `${name}: ${recordPath} holds no list of { command, cause } entries for this CLI. Repair: give "${name}" the list of owed results its self-verification run leaves.`,
      ],
    };
  return { expected: kept, failures: [] };
}

function runFailure(own: OwnCli, { command, ran }: OwnCliRun): string[] {
  const line = `${checkLine} ${command}`;
  if (ran.exit === 70)
    return [
      `${own.name}: ${line} exited 70, so its run cannot be trusted: ${ran.stderr.trim()} Repair: follow each RAW FAIL line's repair, then run this test again.`,
    ];
  const envelope = parsed(ran.stdout);
  if (ran.exit !== 0) {
    const repair = field(envelope, "result", "repairAction");
    const message = field(envelope, "message");
    return [
      `${own.name}: ${line} exited ${String(ran.exit)}: ${typeof message === "string" ? message : ran.stderr.trim()} Repair: ${typeof repair === "string" ? repair : `run ${line} by hand on ${own.entry} and follow its message.`}`,
    ];
  }
  if (field(envelope, "result", "data") === undefined)
    return [
      `${own.name}: ${line} exited 0 with no envelope on stdout. Repair: run ${line} --json by hand on ${own.entry}; verify-cli must print one envelope.`,
    ];
  return [];
}

function missingFields(
  own: OwnCli,
  command: string,
  data: unknown,
  fields: Readonly<Record<string, "list" | "number">>,
): string[] {
  return Object.entries(fields)
    .filter(([name, kind]) =>
      kind === "list"
        ? !Array.isArray(field(data, name))
        : typeof field(data, name) !== "number",
    )
    .map(
      ([name, kind]) =>
        `${own.name}: ${checkLine} ${command}'s result holds no ${name} ${kind}. Repair: run ${checkLine} ${command} --json by hand and repair verify-cli's output; a missing ${name} never reads as empty.`,
    );
}

function sweepOwed(own: OwnCli, data: unknown) {
  const checks = field(data, "checks");
  const failures = missingFields(own, "sweep", data, { owed: "list" });
  if (!(typeof checks === "number" && checks > 0))
    failures.push(
      `${own.name}: the sweep ran no check. Repair: a sweep that checks nothing proves nothing; run ${checkLine} sweep ${own.entry} by hand and repair the target's discovery.`,
    );
  return { owed: listOf(field(data, "owed")).map(owedResult), failures };
}

function reportOwed(own: OwnCli, data: unknown) {
  const failures = missingFields(own, "report", data, {
    findings: "number",
    unmet: "list",
    unconfirmed: "list",
    stations: "list",
  });
  const findings = field(data, "findings");
  if (typeof findings === "number" && findings !== 0)
    failures.push(
      `${own.name}: the sweep found ${String(findings)} failed checks. Repair: run ${checkLine} findings ${own.entry} for the list, then repair the target or its declarations.`,
    );
  for (const step of listOf(field(data, "unmet")))
    failures.push(
      `${own.name}: step ${String(field(step, "step"))} is unmet: ${listOf(field(step, "unmet")).join(", ")}. Repair: make the target do what the step expects. Change the scenario in ${featurePath} only when the example's documented output changed on purpose.`,
    );
  for (const step of listOf(field(data, "unconfirmed")))
    failures.push(
      `${own.name}: step ${String(step)}'s process end was not confirmed. Repair: make the target exit on its own within the step's limit.`,
    );
  const stations = listOf(field(data, "stations"));
  if (!stations.some((station) => field(station, "state") === "driven"))
    failures.push(
      `${own.name}: the scenario drove no station. Repair: give ${featurePath}'s scenario a met --json step.`,
    );
  return {
    owed: stations
      .filter((station) => field(station, "state") === "owed")
      .map(owedResult),
    failures,
  };
}

function owedFailures(
  name: string,
  observed: readonly OwedResult[],
  expected: readonly OwedResult[],
): string[] {
  const seen = new Set(observed.map(key));
  const recorded = new Set(expected.map(key));
  return [
    ...[...seen]
      .filter((entry) => !recorded.has(entry))
      .map(
        (entry) =>
          `${name}: ${entry} is owed and ${recordPath} does not list it. Repair: drive it with a --json step in a scenario, or add it to "${name}" in that record when no scenario can reach it yet.`,
      ),
    ...[...recorded]
      .filter((entry) => !seen.has(entry))
      .map(
        (entry) =>
          `${name}: ${recordPath} lists ${entry}, which is no longer owed. Repair: remove it from "${name}" in that record.`,
      ),
  ];
}

export function ownCliFailures(own: OwnCli, record: unknown): string[] {
  const { expected, failures } = recordFailures(own.name, record);
  const ranFailures = own.runs.flatMap((run) => runFailure(own, run));
  const last = own.runs.at(-1);
  if (last !== undefined && runFailure(own, last).length > 0)
    return [...failures, ...ranFailures];
  const data = field(parsed(last?.ran.stdout ?? ""), "result", "data");
  const judged =
    last?.command === "sweep"
      ? sweepOwed(own, data)
      : last?.command === "report"
        ? reportOwed(own, data)
        : undefined;
  if (judged === undefined)
    return [
      ...failures,
      ...ranFailures,
      `${own.name}: its runs end with ${String(last?.command)}, which lists no owed results. Repair: end them with sweep or report.`,
    ];
  const owed = judged.owed.filter((entry) => entry !== undefined);
  const unread =
    owed.length === judged.owed.length
      ? []
      : [
          `${own.name}: ${last?.command ?? ""} listed an owed result with no command or cause. Repair: run ${checkLine} ${last?.command ?? ""} --json by hand and repair verify-cli's output.`,
        ];
  return [
    ...failures,
    ...ranFailures,
    ...judged.failures,
    ...unread,
    ...owedFailures(own.name, owed, expected),
  ];
}
