import { join, resolve } from "node:path";
import {
  at,
  evidenceBytesLimit,
  listOf,
  readJsonFile,
  readRegularFile,
} from "../helper/json.ts";
import {
  cli,
  readIndex,
  sha256,
  stepSchema,
  verificationRun,
} from "../helper/place.ts";
import type { RunRow, StepRow } from "../helper/place.ts";
import { inspectApprovalFolder, inspectDiagnosticsFolder } from "./addons.ts";
import { forensicsSchema, lstatSafe, openRealDirectory } from "./io.ts";
import { inspectStateRoot } from "./state.ts";
import type { StateForensicsReport } from "./state.ts";

const forensicsKinds = ["run", "state", "diagnostics", "approval"] as const;
type ForensicsKind = (typeof forensicsKinds)[number];

export type ForensicsWrite = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export type ForensicsOutcome = {
  readonly exit: number;
  readonly writes: readonly ForensicsWrite[];
};

export type RunStepForensics = {
  readonly feature: string;
  readonly step: string;
  readonly runner: "target" | "bun";
  readonly verdict: "met" | "unmet";
  readonly hashMatches: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean | null;
  readonly outputTruncated: boolean | null;
  readonly terminationConfirmed: boolean | null;
  readonly unmet: readonly string[];
  readonly contractFailures: readonly string[];
  readonly repositoryDrifted: boolean;
  readonly file: string;
};

export type RunForensicsReport = {
  readonly schema: typeof forensicsSchema;
  readonly target: "run";
  readonly path: string;
  readonly status: "clean" | "issues";
  readonly summary: string;
  readonly scratchPresent: boolean;
  readonly run: {
    readonly repository: string;
    readonly target: string;
    readonly pinnedCommit: string;
    readonly bun: string;
    readonly platform: string;
    readonly headCommit: string | null;
    readonly uncommittedPaths: number | null;
  } | null;
  readonly steps: readonly RunStepForensics[];
  readonly helperState: StateForensicsReport | null;
  readonly problems: readonly string[];
};

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function checkStepHash(stepPath: string, row: StepRow) {
  const raw = readRegularFile(stepPath, evidenceBytesLimit);
  if (raw.kind !== "read")
    return {
      hashMatches: false,
      problem:
        raw.kind === "missing"
          ? `evidence file missing: ${row.file}`
          : `evidence file unreadable (${row.file}): ${raw.reason}`,
    };
  const hashMatches = sha256(raw.bytes) === row.sha256;
  return {
    hashMatches,
    problem: hashMatches
      ? undefined
      : `evidence hash mismatch on ${row.file}: file was altered after drive`,
  };
}

function stepDocProblems(
  row: StepRow,
  doc: unknown,
  unmet: readonly string[],
  terminationConfirmed: boolean | null,
  repositoryDrifted: boolean,
): readonly string[] {
  return [
    ...(doc !== undefined && at(doc, "schema") !== stepSchema
      ? [`evidence file ${row.file} has unexpected schema`]
      : []),
    ...(row.verdict === "unmet"
      ? [
          `step ${row.feature}/${row.step} is unmet: ${unmet.join(", ") || "unknown"}`,
        ]
      : []),
    ...(terminationConfirmed === false
      ? [`step ${row.feature}/${row.step} did not confirm process termination`]
      : []),
    ...(repositoryDrifted
      ? [`repository state changed before step ${row.feature}/${row.step}`]
      : []),
  ];
}

function inspectStepEvidence(
  evidenceDir: string,
  run: RunRow,
  row: StepRow,
): { readonly step: RunStepForensics; readonly problems: readonly string[] } {
  const stepPath = join(evidenceDir, row.file);
  const checked = checkStepHash(stepPath, row);
  const json = readJsonFile(stepPath, evidenceBytesLimit);
  const doc = json.kind === "read" ? json.value : undefined;
  const unmet = listOf(at(doc, "unmet")).flatMap((item) =>
    typeof item === "string" ? [item] : [],
  );
  const terminationConfirmed = boolOrNull(
    at(doc, "observed", "terminationConfirmed"),
  );
  const repositoryDrifted =
    doc !== undefined &&
    (at(doc, "repository", "headCommit") !== run.headCommit ||
      at(doc, "repository", "uncommittedPaths") !== run.uncommittedPaths);
  const problems = [
    ...(checked.problem === undefined ? [] : [checked.problem]),
    ...stepDocProblems(
      row,
      doc,
      unmet,
      terminationConfirmed,
      repositoryDrifted,
    ),
  ];
  return {
    step: {
      feature: row.feature,
      step: row.step,
      runner: row.runner,
      verdict: row.verdict,
      hashMatches: checked.hashMatches,
      exitCode: row.exitCode,
      timedOut: boolOrNull(at(doc, "observed", "timedOut")),
      outputTruncated: boolOrNull(at(doc, "observed", "outputTruncated")),
      terminationConfirmed,
      unmet,
      contractFailures: unmet.filter((item) => item.startsWith("contract.")),
      repositoryDrifted,
      file: row.file,
    },
    problems,
  };
}

export function inspectRunFolder(
  folder: string,
):
  | { readonly ok: true; readonly report: RunForensicsReport }
  | { readonly ok: false; readonly reason: string } {
  const opened = openRealDirectory("Run folder", folder);
  if (!opened.ok) return opened;

  const place = verificationRun(folder);
  const scratchPresent = lstatSafe(place.scratch).kind === "ok";
  const problems: string[] = [];

  const index = readIndex(place);
  let runMeta: RunForensicsReport["run"] = null;
  const steps: RunStepForensics[] = [];

  if (index.kind === "missing") {
    problems.push(`evidence index is missing at ${place.index}`);
  } else if (index.kind === "unreadable") {
    problems.push(`evidence index unreadable: ${index.reason}`);
  } else {
    runMeta = {
      repository: index.run.repository,
      target: index.run.target,
      pinnedCommit: index.run.pinnedCommit,
      bun: index.run.bun,
      platform: index.run.platform,
      headCommit: index.run.headCommit,
      uncommittedPaths: index.run.uncommittedPaths,
    };
    for (const row of index.steps) {
      const checked = inspectStepEvidence(place.evidence, index.run, row);
      steps.push(checked.step);
      problems.push(...checked.problems);
    }
  }

  const stateInspect = inspectStateRoot(place.state);
  const helperState = stateInspect.ok ? stateInspect.report : null;
  if (!stateInspect.ok)
    problems.push(`helper state unavailable: ${stateInspect.reason}`);
  else
    for (const issue of stateInspect.report.problems)
      problems.push(`helper state: ${issue}`);

  const unmetCount = steps.filter((step) => step.verdict === "unmet").length;
  const status = problems.length === 0 ? "clean" : "issues";
  const summary = `Verification run (${scratchPresent ? "scratch present" : "scratch removed"}): ${String(steps.length)} step(s) (${String(unmetCount)} unmet), ${String(problems.length)} problem(s).`;

  return {
    ok: true,
    report: {
      schema: forensicsSchema,
      target: "run",
      path: folder,
      status,
      summary,
      scratchPresent,
      run: runMeta,
      steps,
      helperState,
      problems,
    },
  };
}

function usageHelp(self: string): string {
  return [
    `Usage: ${self} forensics <run|state|diagnostics|approval> <path> [--json]`,
    "",
    "Kernel-free, read-only forensic inspection of raw verification and add-on artifacts.",
    "Works even when agent-cli-kernel cannot start or verify.ts exits 70.",
    "",
    "Targets:",
    "  run <run folder>             Verify evidence hashes, unmet steps, and helper state",
    "  state <state root>           Decode C3S1 state journal v1/v2, locks, torn tails, closures",
    "  diagnostics <folder>         Decode custody locks, residue, closed markers, and JSONL summaries",
    "  approval <folder>            Decode consumed markers and grant/closure/stop JSON records",
  ].join("\n");
}

function errorOutput(
  json: boolean,
  exit: 2 | 3,
  kind: "usage" | "unreadable",
  message: string,
  repair: string,
): ForensicsOutcome {
  if (json)
    return {
      exit,
      writes: [
        {
          stream: "stdout",
          text: `${JSON.stringify({ schema: forensicsSchema, ok: false, kind, message, repair })}\n`,
        },
      ],
    };
  return {
    exit,
    writes: [
      { stream: "stderr", text: `${cli}: ${message} Repair: ${repair}\n` },
    ],
  };
}

function dispatchTarget(kind: ForensicsKind, resolved: string) {
  if (kind === "run") return inspectRunFolder(resolved);
  if (kind === "state") return inspectStateRoot(resolved);
  if (kind === "diagnostics") return inspectDiagnosticsFolder(resolved);
  return inspectApprovalFolder(resolved);
}

function parseForensicsArgs(args: readonly string[], self: string) {
  const literal = args.indexOf("--");
  const before = literal === -1 ? args : args.slice(0, literal);
  const after = literal === -1 ? [] : args.slice(literal + 1);
  const json = before.includes("--json");
  const help = before.includes("--help") || before.includes("-h");
  const badOption = before.find(
    (word) =>
      word.startsWith("-") &&
      word !== "--json" &&
      word !== "--help" &&
      word !== "-h",
  );
  if (badOption !== undefined)
    return {
      done: true as const,
      outcome: errorOutput(
        json,
        2,
        "usage",
        `Unknown option ${badOption} for forensics.`,
        `Run ${self} forensics --help to see the supported options.`,
      ),
    };
  if (help)
    return {
      done: true as const,
      outcome: {
        exit: 0,
        writes: [{ stream: "stdout" as const, text: `${usageHelp(self)}\n` }],
      },
    };
  const positionals = before
    .filter((word) => !word.startsWith("-"))
    .concat(after);
  const kind = forensicsKinds.find((entry) => entry === positionals[0]);
  const targetPath = positionals[1];
  if (
    kind === undefined ||
    targetPath === undefined ||
    positionals.length !== 2
  )
    return {
      done: true as const,
      outcome: errorOutput(
        json,
        2,
        "usage",
        "forensics requires a target kind (run, state, diagnostics, or approval) and one path.",
        `Run ${self} forensics <run|state|diagnostics|approval> <path> [--json].`,
      ),
    };
  return { done: false as const, kind, targetPath, json };
}

export function runForensics(
  args: readonly string[],
  cwd: string,
  self: string,
): ForensicsOutcome {
  const parsed = parseForensicsArgs(args, self);
  if (parsed.done) return parsed.outcome;
  const inspected = dispatchTarget(
    parsed.kind,
    resolve(cwd, parsed.targetPath),
  );
  if (!inspected.ok)
    return errorOutput(
      parsed.json,
      3,
      "unreadable",
      inspected.reason,
      "Pass an existing, readable directory for that forensic target.",
    );
  const text = parsed.json
    ? `${JSON.stringify(inspected.report)}\n`
    : `${inspected.report.summary}\n${JSON.stringify(inspected.report, null, 2)}\n`;
  return { exit: 0, writes: [{ stream: "stdout", text }] };
}
