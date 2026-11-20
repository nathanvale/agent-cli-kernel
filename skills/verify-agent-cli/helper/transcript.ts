import type { JsonValue } from "agent-cli-kernel";
import { at, parsedJson } from "./json.ts";

export type Expectations = {
  readonly exitCode: number | undefined;
  readonly causeCode: string | undefined;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
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
