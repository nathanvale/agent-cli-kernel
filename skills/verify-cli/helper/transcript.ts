import type { JsonValue } from "agent-cli-kernel";
import { at, parsedJson } from "./json.ts";

export type Expectations = {
  readonly exitCode: number | undefined;
  readonly causeCode: string | undefined;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly emptyStdout: boolean;
  readonly emptyStderr: boolean;
  readonly file: string | undefined;
};

export type Seen = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly file: string | null;
};

export type Check = {
  readonly expectation: string;
  readonly wanted: JsonValue;
  readonly seen: JsonValue;
  readonly met: boolean;
};

export function envelopeOf(stdout: string): unknown {
  const lines = stdout.split("\n");
  if (lines.length !== 2 || lines[1] !== "") return null;
  const parsed = parsedJson(lines[0] ?? "");
  return typeof at(parsed, "contractVersion") === "string" &&
    typeof at(parsed, "result") === "object"
    ? parsed
    : null;
}

export function identityOf(envelope: unknown): string | null {
  const named = at(envelope, "result", "commandIdentity");
  return typeof named === "string" ? named : null;
}

export function causeOf(envelope: unknown, stderr: string): string | null {
  const fromEnvelope = at(envelope, "result", "causeCode");
  if (typeof fromEnvelope === "string") return fromEnvelope;
  const line = /\[([A-Z][A-Z0-9_]*)\]\n$/.exec(stderr);
  return line?.[1] ?? null;
}

export function checks(expected: Expectations, seen: Seen): Check[] {
  const envelope = envelopeOf(seen.stdout);
  const cause = causeOf(envelope, seen.stderr);
  return [
    ...(expected.exitCode === undefined
      ? []
      : [
          {
            expectation: "--expect-exit",
            wanted: expected.exitCode,
            seen: seen.exitCode,
            met: seen.exitCode === expected.exitCode,
          },
        ]),
    ...(expected.causeCode === undefined
      ? []
      : [
          {
            expectation: "--expect-cause",
            wanted: expected.causeCode,
            seen: cause,
            met: cause === expected.causeCode,
          },
        ]),
    ...expected.stdout.map((text) => ({
      expectation: "--expect-stdout",
      wanted: text,
      seen: seen.stdout.includes(text),
      met: seen.stdout.includes(text),
    })),
    ...expected.stderr.map((text) => ({
      expectation: "--expect-stderr",
      wanted: text,
      seen: seen.stderr.includes(text),
      met: seen.stderr.includes(text),
    })),
    ...(expected.file === undefined
      ? []
      : [
          {
            expectation: "--expect-file",
            wanted: expected.file,
            seen: seen.file,
            met: seen.file !== null && seen.file.includes(expected.file),
          },
        ]),
    ...(expected.emptyStdout
      ? [
          {
            expectation: "--expect-empty-stdout",
            wanted: "",
            seen: seen.stdout,
            met: seen.stdout === "",
          },
        ]
      : []),
    ...(expected.emptyStderr
      ? [
          {
            expectation: "--expect-empty-stderr",
            wanted: "",
            seen: seen.stderr,
            met: seen.stderr === "",
          },
        ]
      : []),
  ];
}

function asksForJson(argv: readonly string[]): boolean {
  const literal = argv.indexOf("--");
  return (literal < 0 ? argv : argv.slice(0, literal)).includes("--json");
}

export function contractChecks(
  seen: Seen,
  argv: readonly string[],
  how: { readonly script: boolean; readonly timedOut: boolean },
): Check[] {
  if (how.script || how.timedOut || seen.exitCode === null) return [];
  const envelope = envelopeOf(seen.stdout);
  const claimed = at(envelope, "result", "exitCode");
  const json = asksForJson(argv);
  return [
    ...(json
      ? [
          {
            expectation: "contract: --json prints one envelope on stdout",
            wanted: true,
            seen: envelope !== null,
            met: envelope !== null,
          },
          {
            expectation: "contract: --json leaves stderr empty",
            wanted: "",
            seen: seen.stderr,
            met: seen.stderr === "",
          },
        ]
      : []),
    ...(envelope === null
      ? []
      : [
          {
            expectation: "contract: the envelope's exit code is the process's",
            wanted: seen.exitCode,
            seen: typeof claimed === "number" ? claimed : null,
            met: claimed === seen.exitCode,
          },
        ]),
    ...(!json && seen.exitCode !== 0
      ? [
          {
            expectation: "contract: a failed run prints nothing on stdout",
            wanted: "",
            seen: seen.stdout,
            met: seen.stdout === "",
          },
        ]
      : []),
  ];
}
