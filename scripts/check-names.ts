import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  namesOnPaths,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  stagedNewPaths,
} from "./glossary.ts";

const root = join(import.meta.dir, "..");
const usage =
  "Usage: bun run check:names <path> [path ...] | --staged | --tool-call";

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
  return /^(?:\.\.(?:\/|$)|\/|$)/.test(path) ? undefined : path;
}

function givenPath(arg: string): string {
  const path = pathWithin(root, resolve(arg));
  if (path === undefined)
    throw new UsageError(`${arg} is outside this repository.`);
  return path;
}

function givenPaths(args: readonly string[]): string[] {
  const option = args.find((arg) => arg.startsWith("--"));
  if (option !== undefined) throw new UsageError(`Unknown option "${option}".`);
  return args.map(givenPath);
}

function owningTree(path: string): string | undefined {
  const folder = dirname(path);
  if (existsSync(join(folder, ".git"))) return folder;
  return folder === path ? undefined : owningTree(folder);
}

function hasNamesCheck(tree: string): boolean {
  return (
    existsSync(join(tree, "GLOSSARY.md")) &&
    existsSync(join(tree, recordedHitsFile))
  );
}

function problemsCreating(file: string): string[] {
  const tree = owningTree(file);
  if (tree === undefined || !hasNamesCheck(tree)) return [];
  return problemsIn(
    tree,
    namesOnPaths([relative(tree, file)]).filter(
      (name) => !existsSync(join(tree, name)),
    ),
  );
}

function ownFields(value: unknown): Map<string, unknown> {
  return new Map(
    typeof value === "object" && value !== null ? Object.entries(value) : [],
  );
}

type CallReader = {
  readonly field: string;
  readonly created: (value: string) => string[];
};

const callReaders = new Map<unknown, CallReader>([
  ["Write", { field: "file_path", created: (filePath) => [filePath] }],
  [
    "apply_patch",
    {
      field: "command",
      created: (patch) =>
        [...patch.matchAll(/^\*\*\* (?:Add File|Move to): (.+?)\s*$/gm)].map(
          ([, path = ""]) => path,
        ),
    },
  ],
]);

function createdPaths(tool: unknown, input: Map<string, unknown>): string[] {
  const reader = callReaders.get(tool);
  const value = reader === undefined ? undefined : input.get(reader.field);
  if (reader === undefined || typeof value !== "string")
    throw new Error(
      `--tool-call cannot read a ${String(tool)} call. It reads the file_path of a Write call and the command of an apply_patch call. Wire the names gate to those tools only.`,
    );
  return reader.created(value);
}

function toolCallProblems(hookInput: string): string[] {
  const call = ownFields(JSON.parse(hookInput));
  const cwd = call.get("cwd");
  const from = typeof cwd === "string" ? cwd : process.cwd();
  return createdPaths(
    call.get("tool_name"),
    ownFields(call.get("tool_input")),
  ).flatMap((path) => problemsCreating(resolve(from, path)));
}

const modes = new Map<string, () => Promise<string[]>>([
  [
    "--staged",
    () => Promise.resolve(problemsIn(root, namesOnPaths(stagedNewPaths(root)))),
  ],
  ["--tool-call", async () => toolCallProblems(await Bun.stdin.text())],
]);

function problemsFor(args: readonly string[]): Promise<string[]> {
  const [first, ...rest] = args;
  if (first === undefined)
    throw new UsageError("Give at least one path, --staged or --tool-call.");
  const mode = modes.get(first);
  if (mode === undefined)
    return Promise.resolve(problemsIn(root, namesOnPaths(givenPaths(args))));
  if (rest.length > 0) throw new UsageError(`${first} takes no path.`);
  return mode();
}

let code: number;
try {
  const problems = new Set(await problemsFor(process.argv.slice(2)));
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  code = problems.size > 0 ? 1 : 0;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${error instanceof UsageError ? `${usage}. ` : ""}${reason}\n`,
  );
  code = 2;
}
process.exitCode = code;
