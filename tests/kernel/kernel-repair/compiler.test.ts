import { expect } from "bun:test";
import { join, resolve } from "node:path";
import { probeBatch } from "../locks/lock-probes.ts";
import { runFamily } from "./harness.ts";

const root = resolve(import.meta.dir, "../../..");
const kernel = join(root, "kernel/src/kernel/index.ts");
const probe = probeBatch("kernel-repair-locks-");
const compilers = ["native", "lint-view"] as const;
type Check = () => Promise<void>;

const header = (setup: string) =>
  `import { contractFor, commonCauses } from ${JSON.stringify(kernel)};\nimport type { CauseTable, InputSchema, ParsedInput, ResultFor } from ${JSON.stringify(kernel)};\nvoid contractFor; void commonCauses;\n${setup}\n`;
function compiles(setup: string, statement: string): Check {
  const program = probe(`${header(setup)}${statement}\n`);
  return async () => {
    for (const compiler of compilers)
      expect(await program.compile(compiler)).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
  };
}
function lock(
  setup: string,
  invalid: string,
  valid: string,
  code: number,
): Check {
  const prefix = header(setup);
  const line = prefix.split("\n").length + 1;
  const marked = probe(
    `${prefix}// @ts-expect-error -- repair lock\n${invalid}\n`,
  );
  const unmarked = probe(`${prefix}// removed marker\n${invalid}\n`);
  const twin = compiles(setup, valid);
  return async () => {
    for (const compiler of compilers) {
      expect(await marked.compile(compiler)).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
      const rejected = await unmarked.compile(compiler);
      expect(rejected.stderr).toBe("");
      expect(
        rejected.diagnostics.map((found) => ({
          line: found.line,
          code: found.code,
        })),
      ).toEqual([{ line, code }]);
    }
    await twin();
  };
}
function inOrder(checks: readonly Check[]): Check {
  return async () => {
    for (const check of checks) await check();
  };
}

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
const bothTables = (invalidStatement: string, valid: string) =>
  inOrder(
    Object.values(tables).map((setup) =>
      lock(setup, invalidStatement, valid, 2322),
    ),
  );

const r14 = {
  "R14.widened-valid-twins": inOrder(
    Object.values(twins).map((twin) => compiles(tables.widened, twin)),
  ),
  "R14.contract-valid-twins": inOrder(
    Object.values(twins).map((twin) => compiles(tables.contract, twin)),
  ),
  "R14.success-repair-lock": bothTables(invalid.successRepair, twins.object),
  "R14.refused-data-lock": bothTables(invalid.refusedData, twins.transient),
  "R14.retryable-no-delay-lock": bothTables(
    invalid.retryNoDelay,
    twins.transient,
  ),
  "R14.non-retryable-delay-lock": bothTables(
    invalid.delayNotRetryable,
    twins.inspect,
  ),
};

const option =
  '{ name: "--tag", aliases: [], summary: "Tag.", required: false, value: { kind: "string", minLength: 1, maxLength: 8, choices: null, pattern: null }';
const schema = (repeatable: string) =>
  `{ arguments: [], options: [${option}, repeatable: ${repeatable} }], constraints: [], deadlineSupported: false, additionalArguments: false, additionalOptions: false }`;
const slots = {
  widened: `const s: InputSchema = ${schema("true")};\ntype Tag = ParsedInput<typeof s>["--tag"];\ndeclare const tags: readonly string[];`,
  literalTrue: `const s = ${schema("true")} as const satisfies InputSchema;\ntype Tag = ParsedInput<typeof s>["--tag"];\ndeclare const tags: readonly string[];`,
  literalFalse: `const s = ${schema("false")} as const satisfies InputSchema;\ntype Tag = ParsedInput<typeof s>["--tag"];\ndeclare const tags: readonly string[];`,
};
const r13 = {
  "R13.widened-array-assigns": compiles(
    slots.widened,
    "const value: Tag = tags;",
  ),
  "R13.widened-scalar-assigns": compiles(
    slots.widened,
    'const value: Tag = "a";',
  ),
  "R13.literal-true-scalar-lock": lock(
    slots.literalTrue,
    'const value: Tag = "a";',
    "const value: Tag = tags;",
    2322,
  ),
  "R13.literal-false-array-lock": lock(
    slots.literalFalse,
    "const value: Tag = tags;",
    'const value: Tag = "a";',
    2322,
  ),
};

const timeout = probe.timeout();
runFamily("R14", r14, timeout);
runFamily("R13", r13, timeout);
