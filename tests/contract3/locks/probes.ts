import { afterAll } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";

export type Compiler = "native" | "lint-view";
export type Compilation = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
  readonly diagnostics: readonly {
    readonly file: string;
    readonly line: number;
    readonly code: number;
  }[];
};
export type Probe = {
  readonly file: string;
  compile(compiler: Compiler): Promise<Compilation>;
};
type Registered = {
  readonly file: string;
  readonly source: string;
  readonly compilers: readonly Compiler[];
  readonly alone: boolean;
};

const root = resolve(import.meta.dir, "../../..");
const executables = {
  native: "node_modules/@typescript/native/bin/tsc",
  "lint-view": "node_modules/typescript/bin/tsc6",
} as const satisfies Record<Compiler, string>;
const failedExit = {
  native: 1,
  "lint-view": 2,
} as const satisfies Record<Compiler, number>;
const both: readonly Compiler[] = ["native", "lint-view"];
const fallbackWidth = 4;
const diagnostic = /^(.+)\((\d+),(\d+)\): error TS(\d+):/;

// Both compilers skip type checking for the whole program when any file fails
// to parse. The sentinel's type error is printed only when checking ran.
const sentinel = {
  file: "locks/sentinel.ts",
  source: 'export const sentinel: number = "sentinel";\n',
  code: 2322,
};

// tsc --pretty false indents a diagnostic's elaboration lines under it.
function records(stdout: string): string[] {
  const result: string[] = [];
  for (const line of stdout.split("\n").filter((text) => text !== "")) {
    const last = result.length - 1;
    if (/^\s/.test(line) && last >= 0) result[last] += `\n${line}`;
    else result.push(line);
  }
  return result;
}

type Parsed = {
  readonly text: string;
  readonly diagnostic?: Compilation["diagnostics"][number];
};

function parse(directory: string, text: string): Parsed {
  const match = diagnostic.exec(text);
  if (!match) return { text };
  return {
    text,
    diagnostic: {
      file: relative(directory, resolve(root, match[1] ?? "")),
      line: Number(match[2]),
      code: Number(match[4]),
    },
  };
}

// What one compiler run settles, and how its unsettled files compile next:
// `together` as one program, or `apart` as one program each.
export type Reading = {
  readonly settled: Map<string, Compilation>;
  readonly together: readonly string[];
  readonly apart: readonly string[];
};

// Reads one compiler run over `files` plus the sentinel. A diagnostic in a
// file no probe owns, such as a fixture the probes import, belongs to every
// probe that imports it; the run cannot say which, so each file compiles
// again alone. A run that skipped type checking settles only the files that
// failed to parse, and the rest compile again together.
export function readRun(
  compiler: Compiler,
  directory: string,
  files: readonly string[],
  run: Pick<Compilation, "stdout" | "stderr" | "exit">,
): Reading {
  if (run.stderr !== "" || run.exit !== failedExit[compiler])
    throw new Error(
      `${compiler} did not complete normally (exit ${run.exit}, stderr ${JSON.stringify(run.stderr)}), so no probe has a result.`,
    );
  const owned = new Map<string, Parsed[]>(files.map((file) => [file, []]));
  const shared: Parsed[] = [];
  let checked = false;
  for (const text of records(run.stdout)) {
    const parsed = parse(directory, text);
    const file = parsed.diagnostic?.file;
    if (file === sentinel.file && parsed.diagnostic?.code === sentinel.code)
      checked = true;
    else
      ((file === undefined ? undefined : owned.get(file)) ?? shared).push(
        parsed,
      );
  }
  const alone = files.length === 1;
  if (shared.length > 0 && !alone)
    return { settled: new Map(), together: [], apart: files };
  const settled = checked
    ? files
    : files.filter(
        (file) => (owned.get(file) ?? []).length > 0 || shared.length > 0,
      );
  if (settled.length === 0)
    throw new Error(
      `${compiler} skipped type checking but no probe failed to parse:\n${run.stdout}`,
    );
  return {
    settled: new Map(
      settled.map((file) => {
        const seen = [...(owned.get(file) ?? []), ...shared];
        const compilation: Compilation = {
          stdout: seen.map(({ text }) => `${text}\n`).join(""),
          stderr: "",
          exit: seen.length === 0 ? 0 : run.exit,
          diagnostics: seen.flatMap(({ diagnostic: found }) =>
            found ? [found] : [],
          ),
        };
        return [file, compilation];
      }),
    ),
    together: files.filter((file) => !settled.includes(file)),
    apart: [],
  };
}

// A probe that writes the global scope would leak into every probe that
// shares its program, so it gets a program of its own.
function changesGlobalScope(source: string): boolean {
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest);
  return (
    file.referencedFiles.length > 0 ||
    file.typeReferenceDirectives.length > 0 ||
    file.libReferenceDirectives.length > 0 ||
    file.statements.some(
      (statement) =>
        ts.isModuleDeclaration(statement) &&
        (ts.isStringLiteral(statement.name) ||
          (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0),
    )
  );
}

export function probeBatch(prefix: string) {
  const registered: Registered[] = [];
  let directory: string | undefined;
  let runs = 0;
  let batch: Promise<Record<Compiler, Map<string, Compilation>>> | undefined;

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function compileProgram(
    base: string,
    compiler: Compiler,
    files: readonly string[],
  ): Promise<Map<string, Compilation>> {
    const config = join(base, `tsconfig-${runs++}.json`);
    await writeFile(
      config,
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        include: [],
        files: [...files, sentinel.file],
      }),
    );
    const run = await spawnBounded(
      [
        process.execPath,
        join(root, executables[compiler]),
        "--noEmit",
        "--pretty",
        "false",
        "-p",
        config,
      ],
      { cwd: root },
    );
    const { settled, together, apart } = readRun(compiler, base, files, run);
    const results = [settled];
    if (together.length > 0)
      results.push(await compileProgram(base, compiler, together));
    for (let start = 0; start < apart.length; start += fallbackWidth)
      results.push(
        ...(await Promise.all(
          apart
            .slice(start, start + fallbackWidth)
            .map((file) => compileProgram(base, compiler, [file])),
        )),
      );
    return new Map(results.flatMap((result) => [...result]));
  }

  async function compileWith(base: string, compiler: Compiler) {
    const mine = registered.filter((probe) =>
      probe.compilers.includes(compiler),
    );
    const programs = [
      mine.filter((probe) => !probe.alone),
      ...mine.filter((probe) => probe.alone).map((probe) => [probe]),
    ].filter((program) => program.length > 0);
    const results = await Promise.all(
      programs.map((program) =>
        compileProgram(
          base,
          compiler,
          program.map((probe) => probe.file),
        ),
      ),
    );
    return new Map(results.flatMap((result) => [...result]));
  }

  async function compileAll() {
    const base = await mkdtemp(join(await realpath(tmpdir()), prefix));
    directory = base;
    await mkdir(join(base, "locks"));
    await symlink(join(root, "node_modules"), join(base, "node_modules"));
    await Promise.all(
      [...registered, sentinel].map((probe) =>
        writeFile(join(base, probe.file), probe.source),
      ),
    );
    const [native, lintView] = await Promise.all([
      compileWith(base, "native"),
      compileWith(base, "lint-view"),
    ]);
    return { native, "lint-view": lintView };
  }

  return function probe(
    source: string,
    compilers: readonly Compiler[] = both,
  ): Probe {
    if (batch)
      throw new Error(
        "Register every probe at module load, before the first compile.",
      );
    const file = `locks/probe-${registered.length}.ts`;
    registered.push({
      file,
      source,
      compilers,
      alone: changesGlobalScope(source),
    });
    return {
      file,
      async compile(compiler) {
        batch ??= compileAll();
        const result = (await batch)[compiler].get(file);
        if (!result)
          throw new Error(
            `${file} (source starts ${JSON.stringify(source.split("\n")[0])}) was not registered for ${compiler}. Add "${compiler}" to the compilers passed when registering it.`,
          );
        const evidence = process.env.CONTRACT3_COMPILER_EVIDENCE;
        if (evidence) {
          const { stdout, stderr, exit } = result;
          await appendFile(
            evidence,
            `${JSON.stringify({ compiler, source, executable: executables[compiler], stdout, stderr, exit })}\n`,
          );
        }
        return result;
      },
    };
  };
}
