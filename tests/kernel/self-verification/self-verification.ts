import { field, parsed } from "../verify-skill/harness.ts";
import {
  recordOf,
  recordPath,
  type Station,
  stationFailures,
  stationOf,
} from "./station-record.ts";

export const featurePath = "skills/verify-cli/features/read-only-command.md";
export const changingFeaturePath =
  "skills/verify-cli/features/changing-command.md";
export const checkLine = "bun skills/verify-cli/verify.ts";
const quoteLimit = 1_500;

export type Ran = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type OwnCliRun = { readonly command: string; readonly ran: Ran };

export type OwnCli = {
  readonly name: string;
  readonly repair: string;
  readonly runs: readonly OwnCliRun[];
  readonly findings?: Ran | undefined;
  readonly evidence?: ReadonlyMap<string, unknown> | undefined;
};

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function quoted(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > quoteLimit ? `${text.slice(0, quoteLimit)}...` : text;
}

const plural = (count: number, word: string) =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

export function featureScenario(
  markdown: string,
  path: string = featurePath,
): unknown {
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)];
  if (blocks.length !== 1)
    throw new Error(
      `${path} shows ${String(blocks.length)} scenario blocks. Repair: keep exactly one json block there, the scenario self-verification drives.`,
    );
  return parsed(blocks[0]?.[1] ?? "");
}

function dataOf(run: OwnCliRun | undefined): unknown {
  return field(parsed(run?.ran.stdout ?? ""), "result", "data");
}

export function wantsFindings(own: OwnCli): boolean {
  return own.runs.some((run) => {
    if (
      field(parsed(run.ran.stdout), "result", "causeCode") ===
      "DOMAIN_VERIFY_FINDINGS"
    )
      return true;
    const found = field(dataOf(run), "findings");
    return run.command === "report" && typeof found === "number" && found > 0;
  });
}

function runFailure(own: OwnCli, { command, ran }: OwnCliRun): string[] {
  const line = `${checkLine} ${command}`;
  if (ran.exit === 70)
    return [
      `${own.name}: ${line} exited 70, so its run cannot be trusted: ${ran.stderr.trim()} Repair: follow each RAW FAIL line's repair, then run this test again.`,
    ];
  const envelope = parsed(ran.stdout);
  if (ran.exit !== 0) {
    const message = field(envelope, "message");
    return [
      `${own.name}: ${line} exited ${String(ran.exit)}: ${typeof message === "string" ? message : ran.stderr.trim()} Repair: ${own.repair}`,
    ];
  }
  if (field(envelope, "result", "data") === undefined)
    return [
      `${own.name}: ${line} exited 0 with no envelope on stdout. Repair: verify-cli must print one envelope with --json; ${own.repair}`,
    ];
  return [];
}

function findingLines(own: OwnCli): string[] {
  if (own.findings === undefined || !wantsFindings(own)) return [];
  const failed = runFailure(own, { command: "findings", ran: own.findings });
  if (failed.length > 0) return failed;
  return listOf(
    field(dataOf({ command: "findings", ran: own.findings }), "findings"),
  ).map(
    (finding) =>
      `${own.name}: check ${String(field(finding, "check"))} on ${quoted(field(finding, "argv"))} expected ${quoted(field(finding, "expected"))} and saw ${quoted(field(finding, "saw"))}. Repair: ${own.repair}`,
  );
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

type Judged = {
  readonly stations: readonly (Station | undefined)[];
  readonly checks: number | undefined;
  readonly failures: string[];
  readonly clean: boolean;
};

function sweepJudged(own: OwnCli, data: unknown): Judged {
  const checks = field(data, "checks");
  const failures = missingFields(own, "sweep", data, {
    swept: "list",
    owed: "list",
  });
  if (!(typeof checks === "number" && checks > 0))
    failures.push(
      `${own.name}: the sweep ran no check. Repair: a sweep that checks nothing proves nothing; ${own.repair}`,
    );
  return {
    stations: [
      ...listOf(field(data, "swept")).map((each) => stationOf(each, "swept")),
      ...listOf(field(data, "owed")).map((each) => stationOf(each, "owed")),
    ],
    checks: typeof checks === "number" && checks > 0 ? checks : undefined,
    failures,
    clean: true,
  };
}

function unmetLines(own: OwnCli, listed: readonly unknown[]): string[] {
  const unmet = new Map<string, unknown>();
  for (const [name, evidence] of own.evidence ?? [])
    if (field(evidence, "verdict") === "unmet")
      unmet.set(name, field(evidence, "unmet"));
  for (const step of listed)
    unmet.set(String(field(step, "step")), field(step, "unmet"));
  return [...unmet].map(([name, keys]) => {
    const evidence = own.evidence?.get(name);
    const shown =
      evidence === undefined
        ? "its evidence file could not be read"
        : `expected ${quoted(field(evidence, "expected"))}, observed ${quoted(field(evidence, "observed"))}`;
    return `${own.name}: step ${name} is unmet at ${listOf(keys).join(", ")}: ${shown}. Repair: make the target do what the step expects. Change the scenario in ${name.startsWith("changing-command/") ? changingFeaturePath : featurePath} only when the example's documented output changed on purpose; ${own.repair}`;
  });
}

function reportJudged(own: OwnCli, data: unknown): Judged {
  const failures = missingFields(own, "report", data, {
    findings: "number",
    unmet: "list",
    unconfirmed: "list",
    stations: "list",
  });
  const findings = field(data, "findings");
  const found = typeof findings === "number" && findings !== 0;
  if (found)
    failures.push(
      `${own.name}: the sweep found ${plural(findings, "failed check")}, each listed here; stations are compared with ${recordPath} once the sweep is clean. Repair: ${own.repair}`,
    );
  failures.push(...unmetLines(own, listOf(field(data, "unmet"))));
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
    stations: stations.map((each) => stationOf(each)),
    checks: undefined,
    failures,
    clean: !found,
  };
}

export function ownCliFailures(own: OwnCli, record: unknown): string[] {
  const recorded = recordOf(own.name, record);
  const ranFailures = own.runs.flatMap((run) => runFailure(own, run));
  const found = findingLines(own);
  const last = own.runs.at(-1);
  if (last !== undefined && runFailure(own, last).length > 0)
    return [
      ...recorded.failures,
      ...ranFailures,
      ...unmetLines(own, []),
      ...found,
    ];
  const data = dataOf(last);
  const judged =
    last?.command === "sweep"
      ? sweepJudged(own, data)
      : last?.command === "report"
        ? reportJudged(own, data)
        : undefined;
  if (judged === undefined)
    return [
      ...recorded.failures,
      ...ranFailures,
      `${own.name}: its runs end with ${String(last?.command)}, which lists no stations. Repair: end them with sweep or report.`,
    ];
  const stations = judged.stations.filter((each) => each !== undefined);
  const unread =
    stations.length === judged.stations.length
      ? []
      : [
          `${own.name}: ${last?.command ?? ""} listed a station with no command, cause or state. Repair: run ${checkLine} ${last?.command ?? ""} --json by hand and repair verify-cli's output.`,
        ];
  const checks =
    recorded.checks === undefined ||
    judged.checks === undefined ||
    recorded.checks === judged.checks
      ? []
      : [
          `${own.name}: the sweep ran ${String(judged.checks)} checks, and ${recordPath} says ${String(recorded.checks)}. Repair: if a command, input or station changed on purpose, set "checks" to ${String(judged.checks)}; otherwise find the check that changed.`,
        ];
  return [
    ...recorded.failures,
    ...ranFailures,
    ...judged.failures,
    ...found,
    ...unread,
    ...(judged.clean
      ? [...checks, ...stationFailures(own.name, stations, recorded)]
      : []),
  ];
}
