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
const both: readonly Compiler[] = ["native", "lint-view"];
const diagnostic = /^(.+)\((\d+),(\d+)\): error TS(\d+):/;

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

function probeExit(
  seen: readonly Parsed[],
  run: { stdout: string; exit: number },
): number {
  const othersOnly = seen.length === 0 && run.stdout !== "";
  return othersOnly ? 0 : run.exit;
}

function split(
  directory: string,
  files: readonly string[],
  run: { stdout: string; stderr: string; exit: number },
): Map<string, Compilation> {
  const owned = new Map<string, Parsed[]>(files.map((file) => [file, []]));
  const shared: Parsed[] = [];
  for (const text of records(run.stdout)) {
    const match = diagnostic.exec(text);
    const parsed: Parsed = match
      ? {
          text,
          diagnostic: {
            file: relative(directory, resolve(root, match[1] ?? "")),
            line: Number(match[2]),
            code: Number(match[4]),
          },
        }
      : { text };
    const file = parsed.diagnostic?.file;
    ((file === undefined ? undefined : owned.get(file)) ?? shared).push(parsed);
  }
  return new Map(
    files.map((file) => {
      const seen = [...(owned.get(file) ?? []), ...shared];
      const compilation: Compilation = {
        stdout: seen.map(({ text }) => `${text}\n`).join(""),
        stderr: run.stderr,
        exit: probeExit(seen, run),
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
  let batch: Promise<Record<Compiler, Map<string, Compilation>>> | undefined;

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function compileWith(base: string, compiler: Compiler) {
    const files = registered
      .filter((probe) => probe.compilers.includes(compiler))
      .map((probe) => probe.file);
    const config = join(base, `tsconfig.${compiler}.json`);
    await writeFile(
      config,
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        include: [],
        files,
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
    return split(base, files, run);
  }

  async function compileAll() {
    const base = await mkdtemp(join(await realpath(tmpdir()), prefix));
    directory = base;
    await mkdir(join(base, "locks"));
    await symlink(join(root, "node_modules"), join(base, "node_modules"));
    await Promise.all(
      registered.map((probe) =>
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
        if (evidence)
          await appendFile(
            evidence,
            `${JSON.stringify({ compiler, source, executable: executables[compiler], ...result })}\n`,
          );
        return result;
      },
    };
  };
}
