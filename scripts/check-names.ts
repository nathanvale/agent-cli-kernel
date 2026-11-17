import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  namesOnPaths,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  stagedNewPaths,
} from "./glossary.ts";

const root = join(import.meta.dir, "..");

function problemsIn(tree: string, names: readonly string[]): string[] {
  return newNameProblems(
    names,
    readGlossary(readFileSync(join(tree, "GLOSSARY.md"), "utf8")),
    readRecordedHits(readFileSync(join(tree, recordedHitsFile), "utf8")),
  );
}

function pathsToJudge(args: readonly string[]): string[] {
  return args[0] === "--staged" ? stagedNewPaths(root) : [...args];
}

const problems = problemsIn(
  root,
  namesOnPaths(pathsToJudge(process.argv.slice(2))),
);
for (const problem of problems) process.stderr.write(`${problem}\n`);
process.exitCode = problems.length > 0 ? 1 : 0;
