import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { at, parsedJson } from "./json.ts";

export const cli = "verify-cli";
export const indexSchema = "verify-index/1";
export const stepSchema = "verify-step/1";
export const scenarioSchema = "verify-scenario/1";

export const usageProbe: readonly string[] = ["--verify-cli-undeclared-option"];
export const discoveryProbe: readonly string[] = ["--discover", "--json"];
export const probeArgvs: readonly (readonly string[])[] = [
  usageProbe,
  discoveryProbe,
];

export const targetLimits = {
  timeoutMilliseconds: 20_000,
  outputLimitBytes: 1_048_576,
  shutdownMilliseconds: 500,
} as const;

export function targetArgs(
  entry: string,
  argv: readonly string[],
): readonly string[] {
  return ["--no-install", entry, ...argv];
}

export type ProbeResult = {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
};

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

const runIdField = /"runId":"[0-9a-f-]{36}"/g;

function withoutRunIds(stdout: string): string {
  return stdout.replaceAll(runIdField, '"runId":""');
}

export function probeResult(
  argv: readonly string[],
  ran: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  },
): ProbeResult {
  return {
    argv: [...argv],
    exitCode: ran.exitCode,
    stdoutBytes: Buffer.byteLength(ran.stdout),
    stdoutSha256: sha256(withoutRunIds(ran.stdout)),
    stderrSha256: sha256(ran.stderr),
  };
}

export function repositoryRoot(path: string): string | undefined {
  let folder = dirname(path);
  for (;;) {
    if (existsSync(join(folder, "package.json"))) return folder;
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

export type VerificationRun = {
  readonly folder: string;
  readonly scratch: string;
  readonly evidence: string;
  readonly index: string;
  readonly state: string;
};

export function verificationRun(folder: string): VerificationRun {
  const evidence = join(folder, "evidence");
  return {
    folder,
    scratch: join(folder, "scratch"),
    evidence,
    index: join(evidence, "index.jsonl"),
    state: join(folder, "state"),
  };
}

export type RunRow = {
  readonly schema: string;
  readonly row: "run";
  readonly repository: string;
  readonly target: string;
  readonly pinnedCommit: string;
  readonly bun: string;
  readonly platform: string;
  readonly headCommit: string | null;
  readonly uncommittedPaths: number | null;
};

export type StepRow = {
  readonly row: "step";
  readonly feature: string;
  readonly step: string;
  readonly runner: "target" | "bun";
  readonly verdict: "met" | "unmet";
  readonly commandIdentity: string | null;
  readonly causeCode: string | null;
  readonly exitCode: number | null;
  readonly file: string;
  readonly sha256: string;
};

export type IndexRead =
  | { readonly kind: "missing" }
  | {
      readonly kind: "read";
      readonly run: RunRow;
      readonly steps: readonly StepRow[];
    }
  | { readonly kind: "unreadable"; readonly reason: string };

function text(value: unknown, name: string): string | undefined {
  const found = at(value, name);
  return typeof found === "string" ? found : undefined;
}

function textOrNull(value: unknown, name: string): string | null | undefined {
  const found = at(value, name);
  return typeof found === "string" || found === null ? found : undefined;
}

function countOrNull(value: unknown, name: string): number | null | undefined {
  const found = at(value, name);
  return found === null ||
    (typeof found === "number" && Number.isSafeInteger(found))
    ? found
    : undefined;
}

export function runRowOf(value: unknown): RunRow | undefined {
  const repository = text(value, "repository");
  const target = text(value, "target");
  const pinnedCommit = text(value, "pinnedCommit");
  const bun = text(value, "bun");
  const platform = text(value, "platform");
  const headCommit = textOrNull(value, "headCommit");
  const uncommittedPaths = countOrNull(value, "uncommittedPaths");
  if (
    text(value, "schema") !== indexSchema ||
    text(value, "row") !== "run" ||
    repository === undefined ||
    target === undefined ||
    pinnedCommit === undefined ||
    bun === undefined ||
    platform === undefined ||
    headCommit === undefined ||
    uncommittedPaths === undefined
  )
    return undefined;
  return {
    schema: indexSchema,
    row: "run",
    repository,
    target,
    pinnedCommit,
    bun,
    platform,
    headCommit,
    uncommittedPaths,
  };
}

export function stepRowOf(value: unknown): StepRow | undefined {
  const feature = text(value, "feature");
  const step = text(value, "step");
  const runner = text(value, "runner");
  const verdict = text(value, "verdict");
  const commandIdentity = textOrNull(value, "commandIdentity");
  const causeCode = textOrNull(value, "causeCode");
  const exitCode = countOrNull(value, "exitCode");
  const file = text(value, "file");
  const hash = text(value, "sha256");
  if (
    text(value, "row") !== "step" ||
    feature === undefined ||
    step === undefined ||
    (runner !== "target" && runner !== "bun") ||
    (verdict !== "met" && verdict !== "unmet") ||
    commandIdentity === undefined ||
    causeCode === undefined ||
    exitCode === undefined ||
    file === undefined ||
    hash === undefined
  )
    return undefined;
  return {
    row: "step",
    feature,
    step,
    runner,
    verdict,
    commandIdentity,
    causeCode,
    exitCode,
    file,
    sha256: hash,
  };
}

export function indexText(rows: readonly (RunRow | StepRow)[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

const indexBytesLimit = 16_777_216;

function readFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readIndex(place: VerificationRun): IndexRead {
  let content: string;
  try {
    const stats = statSync(place.index);
    if (!stats.isFile())
      return {
        kind: "unreadable",
        reason: `${place.index} is not a regular file`,
      };
    if (stats.size > indexBytesLimit)
      return {
        kind: "unreadable",
        reason: `${place.index} is ${String(stats.size)} bytes, over ${String(indexBytesLimit)}`,
      };
    content = readFileSync(place.index, "utf8");
  } catch (error) {
    if (at(error, "code") === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: readFailure(error) };
  }
  const lines = content.split("\n");
  if (lines.pop() !== "")
    return {
      kind: "unreadable",
      reason: `${place.index} does not end with a line feed`,
    };
  const run = runRowOf(parsedJson(lines[0] ?? ""));
  if (run === undefined)
    return {
      kind: "unreadable",
      reason: `${place.index} does not start with a run row`,
    };
  const steps: StepRow[] = [];
  for (const [number, line] of lines.slice(1).entries()) {
    const row = stepRowOf(parsedJson(line));
    if (row === undefined)
      return {
        kind: "unreadable",
        reason: `line ${String(number + 2)} of ${place.index} is not a step row`,
      };
    steps.push(row);
  }
  return { kind: "read", run, steps };
}
