import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFamily } from "./harness.ts";

// Compiler locks for R13 (F11) and R14 (F14), following the oracle lock
// protocol: the marked invalid program compiles, the unmarked one fails with
// exactly one diagnostic of the pinned code on the pinned line, and the valid
// twin compiles, under native TypeScript 7 and the TypeScript 6 lint view.
// Codes and lines are bound against the repaired fixture.
const root = resolve(import.meta.dir, "../../..");
const kernel = join(root, "starters/contract3/src/kernel/index.ts");
let directory = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "contract3-repair-locks-"));
  await mkdir(join(directory, "locks"));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      include: [],
      files: ["locks/probe.ts"],
    }),
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function compile(source: string, compiler: "native" | "lint-view") {
  await writeFile(join(directory, "locks/probe.ts"), source);
  const executable =
    compiler === "native"
      ? "node_modules/@typescript/native/bin/tsc"
      : "node_modules/typescript/bin/tsc6";
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, executable),
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(directory, "tsconfig.json"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    stdout,
    stderr,
    exit,
    diagnostics: [
      ...stdout.matchAll(/^(.+)\((\d+),(\d+)\): error TS(\d+):/gm),
    ].map((match) => ({ line: Number(match[2]), code: Number(match[4]) })),
  };
}
const header = (setup: string) =>
  `import { contractFor, commonCauses } from ${JSON.stringify(kernel)};\nimport type { CauseTable, InputSchema, ParsedInput, ResultFor } from ${JSON.stringify(kernel)};\nvoid contractFor; void commonCauses;\n${setup}\n`;
async function compiles(setup: string, statement: string) {
  for (const compiler of ["native", "lint-view"] as const)
    expect(
      await compile(`${header(setup)}${statement}\n`, compiler),
    ).toMatchObject({ exit: 0, stdout: "", stderr: "" });
}
async function lock(
  setup: string,
  invalid: string,
  valid: string,
  code: number,
) {
  const prefix = header(setup);
  const line = prefix.split("\n").length + 1;
  for (const compiler of ["native", "lint-view"] as const) {
    const marked = await compile(
      `${prefix}// @ts-expect-error -- repair lock\n${invalid}\n`,
      compiler,
    );
    expect(marked).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    const rejected = await compile(
      `${prefix}// removed marker\n${invalid}\n`,
      compiler,
    );
    expect(rejected.stderr).toBe("");
    expect(rejected.diagnostics).toEqual([{ line, code }]);
  }
  await compiles(setup, valid);
}

// R14: result types written from the WIRE-15 rows.
const tables = {
  widened: "type W = ResultFor<CauseTable>;",
  contract:
    'const contract = contractFor({ cli: "specimen", commands: [] });\ntype W = Extract<Awaited<ReturnType<typeof contract.validate>>, { ok: true }>["value"]["result"];',
} as const;
const effects =
  "effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }";
const success = `runId: "r", commandIdentity: "c", causeCode: "S", outcome: "success", transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false, ${effects}, next: { kind: "done" }`;
const transient = `runId: "r", commandIdentity: "c", causeCode: "T", outcome: "refused", transactionState: "unchanged", failureClass: "transient", exitCode: 75, retryable: true, repairAction: "Retry later.", effectClass: "external", ${effects}, next: { kind: "retry" }`;
const twins = {
  object: `const value: W = { ${success}, data: { a: 1 }, repairAction: null, effectClass: "repository-local" };`,
  transient: `const value: W = { ${transient}, data: null, retryDelayMilliseconds: 5 };`,
  inspect: `const value: W = { ${success}, data: null, repairAction: null, effectClass: "inspect" };`,
};
const invalid = {
  successRepair: `const value: W = { ${success}, data: { a: 1 }, repairAction: "x", effectClass: "repository-local" };`,
  refusedData: `const value: W = { ${transient}, data: { a: 1 }, retryDelayMilliseconds: 5 };`,
  retryNoDelay: `const value: W = { ${transient}, data: null };`,
  delayNotRetryable: `const value: W = { ${success}, data: null, repairAction: null, effectClass: "inspect", retryDelayMilliseconds: 5 };`,
};
async function bothTables(invalidStatement: string, valid: string) {
  for (const setup of Object.values(tables))
    await lock(setup, invalidStatement, valid, 2322);
}

runFamily(
  "R14",
  {
    "R14.widened-valid-twins": async () => {
      for (const twin of Object.values(twins))
        await compiles(tables.widened, twin);
    },
    "R14.contract-valid-twins": async () => {
      for (const twin of Object.values(twins))
        await compiles(tables.contract, twin);
    },
    "R14.success-repair-lock": () =>
      bothTables(invalid.successRepair, twins.object),
    "R14.refused-data-lock": () =>
      bothTables(invalid.refusedData, twins.transient),
    "R14.retryable-no-delay-lock": () =>
      bothTables(invalid.retryNoDelay, twins.transient),
    "R14.non-retryable-delay-lock": () =>
      bothTables(invalid.delayNotRetryable, twins.inspect),
  },
  120000,
);

// R13: a repeatable string option, widened and as literal schemas.
const option =
  '{ name: "--tag", aliases: [], summary: "Tag.", required: false, value: { kind: "string", minLength: 1, maxLength: 8, choices: null, pattern: null }';
const schema = (repeatable: string) =>
  `{ arguments: [], options: [${option}, repeatable: ${repeatable} }], constraints: [], deadlineSupported: false, additionalArguments: false, additionalOptions: false }`;
const slots = {
  widened: `const s: InputSchema = ${schema("true")};\ntype Tag = ParsedInput<typeof s>["--tag"];\ndeclare const tags: readonly string[];`,
  literalTrue: `const s = ${schema("true")} as const satisfies InputSchema;\ntype Tag = ParsedInput<typeof s>["--tag"];\ndeclare const tags: readonly string[];`,
  literalFalse: `const s = ${schema("false")} as const satisfies InputSchema;\ntype Tag = ParsedInput<typeof s>["--tag"];\ndeclare const tags: readonly string[];`,
};
runFamily(
  "R13",
  {
    "R13.widened-array-assigns": () =>
      compiles(slots.widened, "const value: Tag = tags;"),
    "R13.widened-scalar-assigns": () =>
      compiles(slots.widened, 'const value: Tag = "a";'),
    "R13.literal-true-scalar-lock": () =>
      lock(
        slots.literalTrue,
        'const value: Tag = "a";',
        "const value: Tag = tags;",
        2322,
      ),
    "R13.literal-false-array-lock": () =>
      lock(
        slots.literalFalse,
        "const value: Tag = tags;",
        'const value: Tag = "a";',
        2322,
      ),
  },
  120000,
);
