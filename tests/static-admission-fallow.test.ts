import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExpectedFallowRuleCounts,
  assertRequiredSemanticEvidence,
  fallowDeadCodeArgs,
  type FallowPass,
  type FallowRuleExpectation,
  finishFallowCapture,
  parseFallowDocument,
  prepareFallowCapture,
} from "./support/static-admission-fallow.ts";
import {
  COMPLEX_SOURCE,
  createProjectFixture,
  git,
  type Invocation,
  makeTypeOnlyDependency,
  readJson,
  runAdmission,
  runNative,
  writeJson,
} from "./support/static-admission-project.ts";

const retainedRoots = new Set<string>();
const createProject = createProjectFixture(retainedRoots);

async function assertFallowRefusal(
  root: string,
  expectedRules: Record<string, number | FallowRuleExpectation>,
  pass: FallowPass = "whole-project",
): Promise<void> {
  git(
    root,
    "add",
    "--",
    ...git(root, "ls-files", "--others", "--modified", "--exclude-standard")
      .trim()
      .split("\n")
      .filter(Boolean),
  );
  git(
    root,
    "-c",
    "user.name=CDS-TS-2 fixture",
    "-c",
    "user.email=cds-ts2@example.invalid",
    "commit",
    "-qm",
    "canary",
  );
  const args = fallowDeadCodeArgs(pass);
  const capture = await prepareFallowCapture(
    retainedRoots,
    root,
    args,
    expectedRules,
  );
  let invocation: Invocation | null = null;
  try {
    invocation = runNative(root, "node_modules/.bin/fallow", args);
    await finishFallowCapture(capture, invocation);
    const document = parseFallowDocument(invocation);
    if (invocation.exitCode === 0) {
      throw new Error(
        "Fallow canary unexpectedly passed:\n" +
          JSON.stringify(document, null, 2),
      );
    }
    expect(invocation.exitCode).not.toBe(0);
    assertExpectedFallowRuleCounts(document, expectedRules);
    assertRequiredSemanticEvidence(document);
    retainedRoots.delete(root);
  } catch (cause) {
    if (capture && invocation === null) {
      await finishFallowCapture(capture, null, cause);
    }
    throw cause;
  }
}

test("Fallow remaining canary: oracle rejects an unrelated finding for a zero rule", () => {
  const unrelatedFinding = {
    summary: { unused_exports: 0, boundary_violations: 1 },
    unused_exports: [],
    boundary_violations: [{ from_path: "src/engine.ts" }],
  };
  expect(() =>
    assertExpectedFallowRuleCounts(unrelatedFinding, { unused_exports: 0 }),
  ).toThrow();
});

test("native Fallow accepts a matching suppression with exact reason suffix", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    COMPLEX_SOURCE["src/engine.ts"] +
      '// fallow-ignore-next-line boundary-violation -- runtime edge is an intentional suppression specimen\nimport { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  const observed = await runAdmission(root, "complex");
  expect(observed.result.status).toBe("admitted");
  expect(observed.invocation.exitCode).toBe(0);
  for (const pass of ["whole-project", "production-dependencies"]) {
    const raw = await readJson(join(observed.evidence, `${pass}.json`));
    const report = JSON.parse(String(raw.stdout)) as Record<string, unknown>;
    expect((report.summary as Record<string, unknown>).stale_suppressions).toBe(
      0,
    );
    expect(
      (report.summary as Record<string, unknown>).boundary_violations,
    ).toBe(0);
    assertRequiredSemanticEvidence(report);
  }
}, 120_000);

test("runs isolated native Fallow reachability, dependency, graph and suppression canaries", async () => {
  const unusedFile = await createProject("simple");
  await writeFile(
    join(unusedFile, "src/orphan.ts"),
    "export const orphan = true;\n",
  );
  await assertFallowRefusal(unusedFile, { unused_files: 1 });
  if (process.env.STATIC_ADMISSION_FOCUS === "unused-file") return;
}, 120_000);

test("Fallow remaining canary: unused-exports", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/model.ts"),
    (await Bun.file(join(root, "src/model.ts")).text()) +
      "\nexport const unusedExport = true;\n",
  );
  await assertFallowRefusal(root, { unused_exports: 1 });
}, 120_000);

test("Fallow remaining canary: unused-types", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/model.ts"),
    (await Bun.file(join(root, "src/model.ts")).text()) +
      "\nexport type UnusedType = { value: string };\n",
  );
  await assertFallowRefusal(root, { unused_types: 1 });
}, 120_000);

test("Fallow remaining canary: unused-dependencies", async () => {
  const root = await createProject("complex");
  const packageJson = await readJson(join(root, "package.json"));
  const dependencies = packageJson.dependencies as Record<string, unknown>;
  dependencies["unused-package"] = "1.0.0";
  await writeJson(join(root, "package.json"), packageJson);
  await writeJson(join(root, "node_modules/unused-package/package.json"), {
    name: "unused-package",
    version: "1.0.0",
    type: "module",
  });
  await assertFallowRefusal(root, { unused_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: unlisted-dependencies", async () => {
  const root = await createProject("complex");
  await writeJson(join(root, "node_modules/not-listed/package.json"), {
    name: "not-listed",
    version: "1.0.0",
    type: "module",
    types: "index.d.ts",
  });
  await writeFile(
    join(root, "node_modules/not-listed/index.d.ts"),
    "export const marker: string;\n",
  );
  await writeFile(
    join(root, "node_modules/not-listed/index.js"),
    'export const marker = "marker";\n',
  );
  await writeFile(
    join(root, "src/diagnostics.ts"),
    (await Bun.file(join(root, "src/diagnostics.ts")).text())
      .replace(
        'import { redactByPattern } from "@logtape/redaction";\n',
        'import { redactByPattern } from "@logtape/redaction";\nimport { marker } from "not-listed";\n',
      )
      .replace(
        'return typeof getLogger === "function" && typeof redactByPattern === "function";',
        'return typeof getLogger === "function" && typeof redactByPattern === "function" && marker === "marker";',
      ),
  );
  await assertFallowRefusal(root, { unlisted_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: unresolved-imports", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/diagnostics.ts"),
    (await Bun.file(join(root, "src/diagnostics.ts")).text()) +
      '\nimport missing from "./missing-module.ts";\nvoid missing;\n',
  );
  await assertFallowRefusal(root, { unresolved_imports: 1 });
}, 120_000);

test("Fallow remaining canary: dev-dependencies-in-production", async () => {
  const root = await createProject("simple");
  const packageJson = await readJson(join(root, "package.json"));
  const devDependencies = packageJson.devDependencies as Record<
    string,
    unknown
  >;
  devDependencies["runtime-helper"] = "1.0.0";
  await writeJson(join(root, "package.json"), packageJson);
  await writeJson(join(root, "node_modules/runtime-helper/package.json"), {
    name: "runtime-helper",
    version: "1.0.0",
    type: "module",
    types: "index.d.ts",
  });
  await writeFile(
    join(root, "node_modules/runtime-helper/index.d.ts"),
    "export const marker: string;\n",
  );
  await writeFile(
    join(root, "node_modules/runtime-helper/index.js"),
    'export const marker = "runtime-helper";\n',
  );
  await writeFile(
    join(root, "src/cli.ts"),
    [
      'import { marker } from "runtime-helper";',
      "",
      "export function main(): string {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );
  await assertFallowRefusal(root, { dev_dependencies_in_production: 1 });
}, 120_000);

test("Fallow remaining canary: type-only-dependencies", async () => {
  const root = await createProject("complex");
  await makeTypeOnlyDependency(root);
  await assertFallowRefusal(
    root,
    { type_only_dependencies: 1 },
    "production-dependencies",
  );
}, 120_000);

test("Fallow remaining canary: test-only-dependencies", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/command-contract.ts"),
    [
      'export type Command = { kind: "help" };',
      "",
      "export const commandSchema = {",
      "  parse(input: unknown): Command {",
      "    if (",
      '      typeof input === "object" &&',
      "      input !== null &&",
      '      "kind" in input &&',
      '      input.kind === "help"',
      "    )",
      '      return { kind: "help" };',
      '    throw new Error("invalid command");',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/unit/unit.test.ts"),
    (await Bun.file(join(root, "tests/unit/unit.test.ts")).text())
      .replace(
        'import { expect, test } from "bun:test";\n',
        'import { expect, test } from "bun:test";\nimport { z } from "zod";\n',
      )
      .replace(
        'expect(main()).toContain("help");',
        'expect(main()).toContain(z.string().parse("help"));',
      ),
  );
  await assertFallowRefusal(root, { test_only_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: circular-dependencies", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      'import { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  await writeFile(
    join(root, "src/runtime.ts"),
    (await Bun.file(join(root, "src/runtime.ts")).text()) +
      'import { execute } from "./engine.ts";\nvoid execute;\n',
  );
  await assertFallowRefusal(root, { circular_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: re-export-cycle", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/command-contract.ts"),
    (await Bun.file(join(root, "src/command-contract.ts")).text()) +
      'export { makeModel } from "./model.ts";\n',
  );
  await writeFile(
    join(root, "src/model.ts"),
    (await Bun.file(join(root, "src/model.ts")).text()) +
      'export { commandSchema } from "./command-contract.ts";\n',
  );
  await assertFallowRefusal(root, { re_export_cycles: 1 });
}, 120_000);

test("Fallow remaining canary: boundary-violation", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      'import { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  await assertFallowRefusal(root, { boundary_violations: 1 });
}, 120_000);

test("Fallow remaining canary: boundary-coverage-violation", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/unclassified.ts"),
    "export const unclassified = true;\n",
  );
  await writeFile(
    join(root, "src/cli.ts"),
    (await Bun.file(join(root, "src/cli.ts")).text())
      .replace(
        'import { runtimeName } from "./runtime.ts";\n',
        'import { runtimeName } from "./runtime.ts";\nimport { unclassified } from "./unclassified.ts";\n',
      )
      .replace(
        "    String(diagnosticsReady()),",
        "    String(diagnosticsReady()),\n    String(unclassified),",
      ),
  );
  await assertFallowRefusal(root, { boundary_coverage_violations: 1 });
}, 120_000);

test("Fallow remaining canary: require-suppression-reason", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      '// fallow-ignore-next-line boundary-violation\nimport { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  await assertFallowRefusal(root, {
    stale_suppressions: {
      count: 1,
      matches: (finding) => finding.missing_reason === true,
    },
  });
}, 120_000);

test("Fallow remaining canary: stale-suppressions", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      '// fallow-ignore-next-line boundary-violation -- stale control\nimport type { Command } from "./command-contract.ts";\nvoid (undefined as Command | undefined);\n',
  );
  await assertFallowRefusal(root, { stale_suppressions: 1 });
}, 120_000);
