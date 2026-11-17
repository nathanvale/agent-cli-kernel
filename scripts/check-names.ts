import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  namesOnPaths,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  stagedNewPaths,
} from "./glossary.ts";

const root = join(import.meta.dir, "..");
const usage = "Usage: bun run check:names <path> [path ...] | --staged";

class UsageError extends Error {}

function problemsIn(tree: string, names: readonly string[]): string[] {
  return newNameProblems(
    names,
    readGlossary(readFileSync(join(tree, "GLOSSARY.md"), "utf8")),
    readRecordedHits(readFileSync(join(tree, recordedHitsFile), "utf8")),
  );
}

function pathWithin(tree: string, absolute: string): string | undefined {
  const path = relative(tree, absolute);
  return path === "" ||
    path === ".." ||
    path.startsWith("../") ||
    isAbsolute(path)
    ? undefined
    : path;
}

function givenPath(arg: string): string {
  const path = pathWithin(root, resolve(arg));
  if (path === undefined)
    throw new UsageError(`${arg} is outside this repository.`);
  return path;
}

function pathsToJudge(args: readonly string[]): string[] {
  const [first, ...rest] = args;
  if (first === undefined)
    throw new UsageError("Give at least one path, or --staged.");
  if (first === "--staged") {
    if (rest.length > 0) throw new UsageError("--staged takes no path.");
    return stagedNewPaths(root);
  }
  const option = args.find((arg) => arg.startsWith("--"));
  if (option !== undefined) throw new UsageError(`Unknown option "${option}".`);
  return args.map(givenPath);
}

function check(args: readonly string[]): number {
  const problems = problemsIn(root, namesOnPaths(pathsToJudge(args)));
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  return problems.length > 0 ? 1 : 0;
}

let code: number;
try {
  code = check(process.argv.slice(2));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${error instanceof UsageError ? `${usage}. ` : ""}${reason}\n`,
  );
  code = 2;
}
process.exitCode = code;
