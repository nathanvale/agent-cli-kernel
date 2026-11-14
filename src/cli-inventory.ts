import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

const SKIP = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "coverage",
  ".fallow",
]);
const SOURCE = new Set([".ts", ".tsx", ".js", ".mjs", ".mts", ".cts", ".cjs"]);
const TOOL_SCRIPT =
  /^(?:test|check|lint|format|typecheck|build|quality|prepare|prepublish|postinstall|clean)(?::|$)/;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return value as Record<string, unknown>;
}

async function inspectPath(
  root: string,
  directory: string,
  entry: import("node:fs").Dirent,
): Promise<string[]> {
  if (SKIP.has(entry.name) || entry.name.startsWith(".")) return [];
  const path = join(directory, entry.name);
  if (entry.isSymbolicLink())
    throw new Error(
      `CLI inventory cannot inspect symbolic link: ${relative(root, path)}`,
    );
  return await ordinaryPaths(root, path, entry);
}

async function ordinaryPaths(
  root: string,
  path: string,
  entry: import("node:fs").Dirent,
): Promise<string[]> {
  if (entry.isDirectory()) return await filesIn(root, path);
  return entry.isFile() ? [path] : [];
}

async function filesIn(root: string, directory = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }))
    paths.push(...(await inspectPath(root, directory, entry)));
  return paths;
}

function scriptTarget(value: string): string | undefined {
  // Shell assignment words may contain quoted spaces; they precede the runtime.
  const command = value.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')*\s+)*/,
    "",
  );
  return /^(?:bun|node|tsx)\s+(?:run\s+)?(?:--[\w=-]+\s+)*["']?([^\s"']+\.(?:[cm]?[jt]sx?))["']?(?:\s|$)/.exec(
    command,
  )?.[1];
}

function binTargets(bin: unknown): string[] {
  if (typeof bin === "string") return [bin];
  return Object.values(object(bin)).filter(
    (target): target is string => typeof target === "string",
  );
}

function manifestTargets(manifest: Record<string, unknown>): string[] {
  const targets = binTargets(manifest.bin);
  for (const [name, script] of Object.entries(object(manifest.scripts))) {
    if (TOOL_SCRIPT.test(name)) continue;
    targets.push(...declaredScriptTarget(script));
  }
  return targets;
}

function declaredScriptTarget(script: unknown): string[] {
  if (typeof script !== "string") return [];
  const target = scriptTarget(script);
  return target === undefined ? [] : [target];
}

async function toolingEntries(paths: string[]): Promise<Set<string>> {
  const targets = new Set<string>();
  for (const path of paths.filter((path) => path.endsWith("package.json"))) {
    const manifest = object(JSON.parse(await readFile(path, "utf8")));
    for (const target of toolingTargets(object(manifest.scripts)))
      targets.add(resolve(path, "..", target));
  }
  return targets;
}

function toolingTargets(scripts: Record<string, unknown>): string[] {
  return Object.entries(scripts)
    .filter(([name]) => TOOL_SCRIPT.test(name))
    .flatMap(([, script]) => declaredScriptTarget(script));
}

function documentationOwner(
  root: string,
  path: string,
  files: Set<string>,
): string {
  let owner = resolve(path, "..");
  while (owner !== root && !files.has(join(owner, "package.json")))
    owner = resolve(owner, "..");
  return owner;
}

async function documentationEntries(
  root: string,
  path: string,
  files: Set<string>,
  tooling: Set<string>,
): Promise<string[]> {
  const owner = documentationOwner(root, path, files);
  const documentation = await readFile(path, "utf8");
  const entries: string[] = [];
  for (const match of documentation.matchAll(
    /(?:bun|node|tsx)\s+(?:run\s+)?(?:--[\w=-]+\s+)*["']?([^\s"'`]+\.(?:[cm]?[jt]sx?))["']?/g,
  )) {
    const target = resolve(owner, match[1] ?? "");
    if (files.has(target) && !tooling.has(target))
      entries.push(relative(root, target));
  }
  return entries;
}

async function manifestEntry(
  root: string,
  path: string,
  target: string,
): Promise<string> {
  const resolved = resolve(path, "..", target);
  if (relative(root, resolved).startsWith(".."))
    throw new Error(`CLI entry leaves the repository: ${target}`);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`CLI entry is not an ordinary file: ${target}`);
  return relative(root, await realpath(resolved));
}

async function manifestEntries(root: string, path: string): Promise<string[]> {
  const manifest = object(JSON.parse(await readFile(path, "utf8")));
  const entries: string[] = [];
  for (const target of manifestTargets(manifest))
    entries.push(await manifestEntry(root, path, target));
  return entries;
}

function applicationSource(root: string, path: string): boolean {
  const local = relative(root, path);
  return (
    SOURCE.has(extname(path)) &&
    !/(?:^|\/)(?:tests?|fixtures|proofs)\//.test(local) &&
    !/\.(?:test|spec)\./.test(local)
  );
}

function importedFile(
  path: string,
  specifier: string,
  files: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(path), specifier);
  return [
    base,
    ...emittedSourceCandidates(base),
    ...[...SOURCE].map((extension) => base + extension),
    ...[...SOURCE].map((extension) => join(base, "index" + extension)),
  ].find((candidate) => files.has(candidate));
}

function emittedSourceCandidates(path: string): string[] {
  const extensions: Record<string, string[]> = {
    ".js": [".ts", ".tsx"],
    ".jsx": [".tsx"],
    ".mjs": [".mts"],
    ".cjs": [".cts"],
  };
  const extension = extname(path);
  return (extensions[extension] ?? []).map(
    (sourceExtension) => path.slice(0, -extension.length) + sourceExtension,
  );
}

async function importedSources(paths: string[]): Promise<Set<string>> {
  const files = new Set(paths);
  const imported = new Set<string>();
  for (const path of paths) {
    const scanner = new Bun.Transpiler({
      loader:
        extname(path) === ".tsx" || extname(path) === ".jsx" ? "tsx" : "ts",
    });
    const source = await readFile(path, "utf8");
    for (const item of scanner.scan(source).imports) {
      const target = importedFile(path, item.path, files);
      if (target !== undefined) imported.add(target);
    }
  }
  return imported;
}

function referenceMarker(source: string, name: string): string {
  let marker = name;
  while (source.includes(marker)) marker += "_";
  return marker;
}

function executableSource(
  path: string,
  source: string,
  imported: boolean,
): boolean {
  const options: Bun.TranspilerOptions = {
    loader: extname(path) === ".tsx" ? "tsx" : "ts",
    deadCodeElimination: false,
    treeShaking: false,
  };
  const original = new Bun.Transpiler(options).transformSync(source);
  // Avoid collisions even when the parser normalizes escaped literal text.
  const occupied = source + original;
  const main = referenceMarker(occupied, "__cliInventoryMain");
  const argv = referenceMarker(occupied, "__cliInventoryArgv");
  const transformed = new Bun.Transpiler({
    ...options,
    define: { "import.meta.main": main, "process.argv": argv },
  }).transformSync(source);
  // Bun substitutes syntax references, never comments, regexes or literal text.
  return (
    transformed.includes(main) || (!imported && transformed.includes(argv))
  );
}

async function sourceEntries(
  root: string,
  paths: string[],
  tooling: Set<string>,
): Promise<string[]> {
  const entries: string[] = [];
  const sources = paths.filter((path) => applicationSource(root, path));
  const imported = await importedSources(sources);
  for (const path of sources) {
    if (
      !tooling.has(path) &&
      executableSource(path, await readFile(path, "utf8"), imported.has(path))
    )
      entries.push(relative(root, path));
  }
  return entries;
}

export async function inventoryApplicationClis(
  root: string,
): Promise<string[]> {
  root = await realpath(root);
  const paths = await filesIn(root);
  const files = new Set(paths);
  const tooling = await toolingEntries(paths);
  const entries = await sourceEntries(root, paths, tooling);
  for (const path of paths.filter((path) => path.endsWith("package.json")))
    entries.push(...(await manifestEntries(root, path)));
  for (const path of paths.filter((path) => path.endsWith(".md")))
    entries.push(...(await documentationEntries(root, path, files, tooling)));
  return [...new Set(entries)].sort();
}

if (import.meta.main) {
  try {
    const root = process.argv[2];
    if (root === undefined)
      throw new Error(
        "Pass the repository root to inventory its application CLIs.",
      );
    const entries = await inventoryApplicationClis(root);
    process.stdout.write(
      `${JSON.stringify({ entries, status: entries.length === 1 ? "admitted" : "refused" })}\n`,
    );
    process.exitCode = entries.length === 1 ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: "refused", reason: error instanceof Error ? error.message : "CLI inventory failed" })}\n`,
    );
    process.exitCode = 1;
  }
}
