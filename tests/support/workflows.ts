import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Step = {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
  readonly "working-directory"?: string;
};

export type Job = {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | string[];
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly steps: readonly Step[];
};

export type Workflow = {
  readonly name: string;
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, Job>;
};

const workflows = join(resolve(import.meta.dir, "../.."), ".github/workflows");

export function workflowFiles(): string[] {
  return readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file));
}

export function workflowOf(file: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(join(workflows, file), "utf8"),
  ) as Workflow;
}

export function jobOf(file: string, name: string): Job {
  const found = workflowOf(file).jobs[name];
  if (found === undefined) throw new Error(`${file} has no job ${name}.`);
  return found;
}

export function checkNames(file: string): string[] {
  return Object.entries(workflowOf(file).jobs).map(
    ([id, job]) => job.name ?? id,
  );
}
