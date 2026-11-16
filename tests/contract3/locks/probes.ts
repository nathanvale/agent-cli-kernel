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

// Reads one compiler run over `files` plus the sentinel. A run that type
// checked settles every file; a run that did not settles only the files that
// failed to parse, and the caller compiles the rest again.
export function readRun(
  compiler: Compiler,
  directory: string,
  files: readonly string[],
  run: Pick<Compilation, "stdout" | "stderr" | "exit">,
): Map<string, Compilation> {
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
  const settled = checked
    ? files
    : files.filter((file) => (owned.get(file) ?? []).length > 0);
  if (settled.length === 0)
    throw new Error(
      `${compiler} skipped type checking but no probe failed to parse:\n${run.stdout}`,
    );
  return new Map(
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
    const settled = readRun(compiler, base, files, run);
    const rest = files.filter((file) => !settled.has(file));
    if (rest.length === 0) return settled;
    return new Map([
      ...settled,
      ...(await compileProgram(base, compiler, rest)),
    ]);
  }

  function compileWith(base: string, compiler: Compiler) {
    return compileProgram(
      base,
      compiler,
      registered
        .filter((probe) => probe.compilers.includes(compiler))
        .map((probe) => probe.file),
    );
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
    registered.push({ file, source, compilers });
    return {
      file,
      async compile(compiler) {
        batch ??= compileAll();
        const result = (await batch)[compiler].get(file);
        if (!result)
          throw new Error(`${file} was not registered for ${compiler}.`);
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
