import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { get_encoding } from "tiktoken";

const limit = 5_000;
const check = "check:file-size";
const gitTimeout = 4_000;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const recordedHits = new Map([
  [
    "tests/planted-faults/fault-records.json",
    {
      lifetime: "standing",
      reason: "Fault replay keeps its records in one file.",
    },
  ],
  [
    "tests/template/glossary/glossary.test.ts",
    { lifetime: "temporary", reason: "Remove at kernel carry-out." },
  ],
  [
    "starters/complex/tests/integration/integration.test.ts",
    {
      lifetime: "temporary",
      reason: "Remove with the old CLI starter in MAG-129.",
    },
  ],
]);

const excludedFolders = [
  "kernel/",
  "tests/kernel/",
  "tools/oxlint/anti-slop/vendor/",
];
const generatedHooks = new Set([
  ".claude/hooks/fallow-gate.sh",
  ".codex/hooks/fallow-gate.sh",
]);

function excluded(path: string): boolean {
  return (
    basename(path) === "bun.lock" ||
    generatedHooks.has(path) ||
    excludedFolders.some((folder) => path.startsWith(folder))
  );
}

function git(root: string, ...args: string[]): Uint8Array {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitTimeout,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(`git ${args.join(" ")} timed out after ${gitTimeout} ms.`);
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout;
}

function gitFields(root: string, ...args: string[]): string[] {
  const fields = decoder.decode(git(root, ...args)).split("\0");
  fields.pop();
  return fields;
}

type ReadBytes = () => Uint8Array | undefined;
type Files = Map<string, ReadBytes | undefined>;

function workingBytes(file: string): Uint8Array | undefined {
  try {
    if (lstatSync(file).isFile() && realpathSync(file) === file)
      return readFileSync(file);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  return undefined;
}

function workingFiles(root: string): Files {
  return new Map(
    gitFields(root, "ls-files", "--cached", "--deduplicate", "-z").map(
      (path) => [path, () => workingBytes(join(root, path))],
    ),
  );
}

function stagedFiles(root: string): Files {
  const fields = gitFields(
    root,
    "diff",
    "--cached",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--ita-invisible-in-index",
    "-z",
    "--",
  );
  const files: Files = new Map();
  for (let index = 0; index < fields.length; index += 2) {
    const [, mode, , object] = fields[index]?.split(" ") ?? [];
    const path = fields[index + 1];
    if (path === undefined || object === undefined)
      throw new Error("git diff returned an incomplete staged file record.");
    const regular = mode === "100644" || mode === "100755";
    files.set(
      path,
      regular ? () => git(root, "cat-file", "blob", object) : undefined,
    );
  }
  return files;
}

function textOf(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined || bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function tokenCount(
  read: ReadBytes | undefined,
  encoding: ReturnType<typeof get_encoding>,
) {
  const text = textOf(read?.());
  return text === undefined ? undefined : encoding.encode_ordinary(text).length;
}

type Verdict = { kind: "record" | "problem"; message: string };

function verdict(path: string, count: number | undefined): Verdict | undefined {
  const label = JSON.stringify(path);
  const hit = recordedHits.get(path);
  const oversized = count !== undefined && count > limit;
  if (hit?.lifetime === "temporary" && !oversized)
    return {
      kind: "problem",
      message: `${label}: stale temporary recorded hit (${count === undefined ? "no tracked UTF-8 text" : `${count} tokens`}, limit ${limit}). Repair: remove its entry from scripts/check-file-size.ts.`,
    };
  if (count === undefined) return undefined;
  if (hit !== undefined)
    return {
      kind: "record",
      message: `${label}: ${count} tokens (limit ${limit}), ${hit.lifetime} recorded hit. ${hit.reason}`,
    };
  if (oversized)
    return {
      kind: "problem",
      message: `${label}: ${count} tokens exceeds the ${limit}-token limit. Repair: shorten or split the file.`,
    };
  return undefined;
}

function scan(files: Files, staged: boolean) {
  const notices: Record<Verdict["kind"], string[]> = {
    record: [],
    problem: [],
  };
  let examined = 0;
  const encoding = get_encoding("o200k_base");
  try {
    for (const [path, read] of files) {
      if (excluded(path)) continue;
      const count = tokenCount(read, encoding);
      if (count !== undefined) examined += 1;
      const notice = verdict(path, count);
      if (notice !== undefined) notices[notice.kind].push(notice.message);
    }
  } finally {
    encoding.free();
  }
  if (examined === 0 && !staged)
    notices.problem.push(
      "no tracked UTF-8 text files to scan. Repair: run the gate in a populated template checkout.",
    );
  return {
    stdout: [
      `${check}: scanned ${examined} ${staged ? "staged" : "tracked"} UTF-8 text files (limit ${limit} tokens).`,
      ...notices.record,
      "",
    ].join("\n"),
    stderr: notices.problem.map((problem) => `${check}: ${problem}\n`).join(""),
    code: notices.problem.length === 0 ? 0 : 1,
  };
}

export function runFileSizeCheck(args: readonly string[], root: string) {
  const [option, ...rest] = args;
  const staged = option === "--staged";
  if (args.length > 0 && (!staged || rest.length > 0))
    return {
      stdout: "",
      stderr: `Usage: bun run ${check} [--staged]\n`,
      code: 2,
    };

  try {
    const tree = realpathSync(root);
    const files = staged ? stagedFiles(tree) : workingFiles(tree);
    if (!staged) {
      for (const [path, hit] of recordedHits)
        if (hit.lifetime === "temporary" && !files.has(path))
          files.set(path, undefined);
    }
    return scan(files, staged);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `${check}: ${reason} Repair: resolve the Git or filesystem error and run the gate again.\n`,
      code: 2,
    };
  }
}

if (import.meta.main) {
  const { stdout, stderr, code } = runFileSizeCheck(
    process.argv.slice(2),
    join(import.meta.dir, ".."),
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
