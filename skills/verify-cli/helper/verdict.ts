import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "agent-cli-kernel";
import { at, listOf, parsedJson } from "./json.ts";
import { stepSchema } from "./place.ts";
import { jsonValue } from "./scenario.ts";
import type { ScenarioStep } from "./scenario.ts";
import { envelopeOf, stringAt } from "./target.ts";

export type StepRun = {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly terminationConfirmed: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type FileKind =
  | "file"
  | "absent"
  | "folder"
  | "other"
  | "too-large"
  | "unreadable";

export type FileSeen = {
  readonly kind: FileKind;
  readonly content: string | null;
};

export function resultAt(result: unknown, path: string): unknown {
  let current = result;
  for (const name of path.split(".")) {
    if (name === "length" && Array.isArray(current))
      current = listOf(current).length;
    else current = at(current, name);
  }
  return current;
}

function asksForJson(argv: readonly string[]): boolean {
  const literal = argv.indexOf("--");
  return (literal < 0 ? argv : argv.slice(0, literal)).includes("--json");
}

export function contractUnmet(
  step: ScenarioStep,
  observed: StepRun,
): readonly string[] {
  if (
    step.runner !== "target" ||
    observed.timedOut ||
    observed.exitCode === null
  )
    return [];
  const envelope = envelopeOf(observed.stdout);
  const json = asksForJson(step.argv);
  return [
    ...(json && envelope === null ? ["contract.json-one-envelope"] : []),
    ...(json && observed.stderr !== "" ? ["contract.json-stderr-empty"] : []),
    ...(envelope !== null &&
    at(envelope, "result", "exitCode") !== observed.exitCode
      ? ["contract.envelope-exit-code"]
      : []),
    ...(!json && observed.exitCode !== 0 && observed.stdout !== ""
      ? ["contract.failure-stdout-empty"]
      : []),
  ];
}

export function unmetOf(
  step: ScenarioStep,
  observed: StepRun,
  files: readonly FileSeen[],
): readonly string[] {
  const expect = step.expect;
  const result = at(envelopeOf(observed.stdout), "result");
  return [
    ...(observed.exitCode === expect.exitCode ? [] : ["exitCode"]),
    ...(observed.timedOut === (expect.timedOut ?? false) ? [] : ["timedOut"]),
    ...(observed.outputTruncated ? ["outputTruncated"] : []),
    ...(expect.stdout === undefined || expect.stdout === observed.stdout
      ? []
      : ["stdout"]),
    ...(expect.stderr === undefined || expect.stderr === observed.stderr
      ? []
      : ["stderr"]),
    ...(expect.stdoutIncludes ?? []).flatMap((text, index) =>
      observed.stdout.includes(text) ? [] : [`stdoutIncludes.${String(index)}`],
    ),
    ...(expect.stderrIncludes ?? []).flatMap((text, index) =>
      observed.stderr.includes(text) ? [] : [`stderrIncludes.${String(index)}`],
    ),
    ...Object.entries(expect.result ?? {}).flatMap(([key, wanted]) =>
      isDeepStrictEqual(resultAt(result, key), wanted) ? [] : [`result.${key}`],
    ),
    ...(expect.files ?? []).flatMap((file, index) => {
      const seen = files[index];
      const held =
        file.absent === true
          ? seen?.kind === "absent"
          : seen?.kind === "file" && seen.content === file.content;
      return held ? [] : [`files.${String(index)}`];
    }),
    ...contractUnmet(step, observed),
  ];
}

export type StepStation = {
  readonly commandIdentity: string | null;
  readonly causeCode: string | null;
};

export function stationOf(step: ScenarioStep, stdout: string): StepStation {
  const envelope = step.runner === "target" ? envelopeOf(stdout) : null;
  return {
    commandIdentity: stringAt(envelope, "result", "commandIdentity"),
    causeCode: stringAt(envelope, "result", "causeCode"),
  };
}

export function stepFile(
  feature: string,
  step: ScenarioStep,
  observed: StepRun,
  files: readonly FileSeen[],
) {
  const unmet = unmetOf(step, observed, files);
  const result = at(envelopeOf(observed.stdout), "result");
  const shown: Readonly<Record<string, JsonValue>> =
    step.expect.result === undefined
      ? { stdout: observed.stdout }
      : {
          result: Object.fromEntries(
            Object.keys(step.expect.result).map((key) => {
              const found = resultAt(result, key);
              return [key, found === undefined ? null : jsonOf(found)];
            }),
          ),
        };
  return {
    schema: stepSchema,
    feature,
    step: step.name,
    runner: step.runner,
    argv: [...step.argv],
    limits: {
      timeoutMilliseconds: step.timeoutMilliseconds,
      outputLimitBytes: step.outputLimitBytes,
    },
    expected: jsonOf(step.expect),
    observed: {
      exitCode: observed.exitCode,
      timedOut: observed.timedOut,
      outputTruncated: observed.outputTruncated,
      terminationConfirmed: observed.terminationConfirmed,
      stdoutBytes: Buffer.byteLength(observed.stdout),
      stderrBytes: Buffer.byteLength(observed.stderr),
      ...shown,
      stderr: observed.stderr,
      files: files.map((file) => file.content),
      fileKinds: files.map((file) => file.kind),
    },
    unmet: [...unmet],
    verdict: unmet.length === 0 ? ("met" as const) : ("unmet" as const),
  };
}

function jsonOf(value: unknown): JsonValue {
  return jsonValue(parsedJson(JSON.stringify(value) ?? "null"));
}
