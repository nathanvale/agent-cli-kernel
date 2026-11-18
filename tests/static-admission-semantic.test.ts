import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  COMPLEX_SOURCE,
  createProjectFixture,
  makeTypeOnlyDependency,
  readJson,
  runAdmission,
  writeJson,
} from "./support/static-admission-project.ts";

const createProject = createProjectFixture();

test("aggregate admission refuses W alone and P alone", async () => {
  const wholeRoot = await createProject("complex");
  await writeFile(
    join(wholeRoot, "tests/unit/orphan.ts"),
    "export const orphan = true;\n",
  );
  const whole = await runAdmission(wholeRoot, "complex");
  expect(whole.result.cause).toBe("whole-project:findings");
  expect(whole.invocation.exitCode).toBe(1);
  const wholePasses = await readJson(join(whole.evidence, "passes.json"));
  expect((wholePasses.whole as Record<string, unknown>).exitCode).toBe(1);
  expect((wholePasses.production as Record<string, unknown>).exitCode).toBe(0);
  await rm(join(wholeRoot, "tests/unit/orphan.ts"));
  expect((await runAdmission(wholeRoot, "complex")).result.status).toBe(
    "admitted",
  );

  const productionRoot = await createProject("complex");
  await makeTypeOnlyDependency(productionRoot);
  const production = await runAdmission(productionRoot, "complex");
  expect(production.result.cause).toBe("production-dependencies:findings");
  expect(production.invocation.exitCode).toBe(1);
  const productionPasses = await readJson(
    join(production.evidence, "passes.json"),
  );
  expect((productionPasses.whole as Record<string, unknown>).exitCode).toBe(0);
  expect(
    (productionPasses.production as Record<string, unknown>).exitCode,
  ).toBe(1);
  await writeFile(
    join(productionRoot, "src/command-contract.ts"),
    COMPLEX_SOURCE["src/command-contract.ts"],
  );
  expect((await runAdmission(productionRoot, "complex")).result.status).toBe(
    "admitted",
  );
}, 120_000);

test("admission native semantic process refuses unavailable companion", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/model.ts"),
    COMPLEX_SOURCE["src/model.ts"] +
      "\nexport const semanticCandidate = true;\n",
  );
  const observed = await runAdmission(root, "complex", {
    FALLOW_TYPE_AWARE_BIN: join(root, "missing-semantic-companion"),
  });
  expect(observed.invocation.exitCode).toBe(1);
  expect(observed.result.cause).toBe("whole-project:native-error");
  const raw = await readJson(join(observed.evidence, "whole-project.json"));
  const report = JSON.parse(String(raw.stdout)) as Record<string, unknown>;
  expect(raw.exitCode).toBe(2);
  expect(report.error).toBe(true);
  expect(String(report.message)).toContain("FALLOW_TYPE_AWARE_BIN");
  expect(String(report.message)).toContain("no file exists there");
}, 120_000);

for (const completeness of ["unavailable", "partial"] as const) {
  test(`admission native semantic process refuses ${completeness} project evidence`, async () => {
    const root = await createProject("complex");
    await writeFile(
      join(root, "src/model.ts"),
      COMPLEX_SOURCE["src/model.ts"] +
        "\nexport const semanticCandidate = true;\n",
    );
    await writeJson(join(root, "tsconfig.semantic-canary.json"), {
      extends: "./tsconfig.json",
      compilerOptions: { module: "NodeNext", moduleResolution: "bundler" },
    });
    const observed = await runAdmission(root, "complex", {
      FALLOW_TYPE_AWARE_PROJECTS: (completeness === "partial"
        ? ["tsconfig.json", "tsconfig.semantic-canary.json"]
        : ["tsconfig.semantic-canary.json"]
      ).join(delimiter),
    });
    expect(observed.invocation.exitCode).toBe(1);
    expect(observed.result.cause).toBe("whole-project:semantic-incomplete");
    const raw = await readJson(join(observed.evidence, "whole-project.json"));
    const report = JSON.parse(String(raw.stdout)) as Record<string, unknown>;
    const semantic = (report._meta as Record<string, unknown>)
      .type_aware as Record<string, unknown>;
    expect((semantic.identity as Record<string, unknown>).completeness).toBe(
      completeness,
    );
  }, 120_000);
}
