import { readdirSync } from "node:fs";
import { join } from "node:path";
import { at, listOf, readJsonFile } from "./json.ts";

export type StepRecord = {
  readonly step: string;
  readonly file: string;
  readonly startedAt: string;
  readonly exitCode: number | null;
  readonly commandIdentity: string | null;
  readonly causeCode: string | null;
  readonly unmet: number;
  readonly contractHeld: boolean;
};

export type Steps = {
  readonly steps: readonly StepRecord[];
  readonly unreadable: readonly string[];
};

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function unmet(value: unknown): number {
  return listOf(value).filter((check) => at(check, "met") !== true).length;
}

export function readSteps(evidence: string): Steps {
  const steps: StepRecord[] = [];
  const unreadable: string[] = [];
  const names = readdirSync(evidence)
    .filter((name) => name.endsWith(".json") && name !== "run.json")
    .sort();
  for (const name of names) {
    const file = join(evidence, name);
    const read = readJsonFile(file);
    const step = read.kind === "read" ? read.value : undefined;
    const startedAt = text(at(step, "startedAt"));
    if (read.kind !== "read" || startedAt === null) {
      unreadable.push(
        read.kind === "unreadable"
          ? read.reason
          : `${file} is not a step this helper wrote`,
      );
      continue;
    }
    const exitCode = at(step, "exitCode");
    steps.push({
      step: name.slice(0, -".json".length),
      file,
      startedAt,
      exitCode: typeof exitCode === "number" ? exitCode : null,
      commandIdentity: text(at(step, "commandIdentity")),
      causeCode: text(at(step, "causeCode")),
      unmet: unmet(at(step, "checks")) + unmet(at(step, "contract")),
      contractHeld: unmet(at(step, "contract")) === 0,
    });
  }
  return {
    steps: steps.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)),
    unreadable,
  };
}
