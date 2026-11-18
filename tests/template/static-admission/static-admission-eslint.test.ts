import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  COMPLEX_SOURCE,
  createProjectFixture,
  hashProjectFiles,
  type Invocation,
  runNative,
  SIMPLE_SOURCE,
  toolPath,
  writeJson,
} from "../../support/static-admission-project.ts";

const createProject = createProjectFixture();

const ESLINT = toolPath("eslint");

async function runLint(root: string): Promise<Invocation> {
  const args = [".", "--max-warnings", "0"];
  const fileHashes = await hashProjectFiles(root);
  const invocation = await runNative(root, ESLINT, args);
  const captureDirectory = process.env.STATIC_ADMISSION_CAPTURE_DIR;
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await writeJson(join(captureDirectory, `biome-${basename(root)}.json`), {
      argv: [ESLINT, ...args],
      cwd: root,
      fileHashes,
      ...invocation,
    });
  }
  return invocation;
}

test("proves typed ESLint ownership canaries and complex exceptions", async () => {
  const allowed = await createProject("simple");
  await writeFile(
    join(allowed, "src/cli.ts"),
    [
      "export function main(): string {",
      '  console.log("human output");',
      '  return "ok";',
      "}",
      "",
    ].join("\n"),
  );
  const allowedResult = await runLint(allowed);
  if (allowedResult.exitCode !== 0) {
    throw new Error(
      "Allowed output owner failed ESLint.\nstdout:\n" +
        allowedResult.stdout +
        "\nstderr:\n" +
        allowedResult.stderr,
    );
  }

  const forbiddenConsole = await createProject("simple");
  await writeFile(
    join(forbiddenConsole, "src/other.ts"),
    'console.log("not the output owner");\n',
  );
  const forbiddenConsoleResult = await runLint(forbiddenConsole);
  expect(forbiddenConsoleResult.exitCode).not.toBe(0);
  expect(
    forbiddenConsoleResult.stdout + forbiddenConsoleResult.stderr,
  ).toContain("no-console");

  const explicitAny = await createProject("simple");
  await writeFile(
    join(explicitAny, "src/other.ts"),
    "export const unsafe: any = 1;\n",
  );
  const explicitAnyResult = await runLint(explicitAny);
  expect(explicitAnyResult.exitCode).not.toBe(0);
  expect(explicitAnyResult.stdout + explicitAnyResult.stderr).toContain(
    "@typescript-eslint/no-explicit-any",
  );

  const nonNull = await createProject("simple");
  await writeFile(
    join(nonNull, "src/other.ts"),
    [
      "const optional: string | undefined = undefined;",
      "export const unsafe = optional!;",
      "",
    ].join("\n"),
  );
  const nonNullResult = await runLint(nonNull);
  expect(nonNullResult.exitCode).not.toBe(0);
  expect(nonNullResult.stdout + nonNullResult.stderr).toContain(
    "@typescript-eslint/no-non-null-assertion",
  );

  const restricted = await createProject("simple");
  await writeFile(
    join(restricted, "src/other.ts"),
    [
      'import { spawn } from "node:child_process";',
      "export const unsafe = spawn;",
      "",
    ].join("\n"),
  );
  const restrictedResult = await runLint(restricted);
  expect(restrictedResult.exitCode).not.toBe(0);
  expect(restrictedResult.stdout + restrictedResult.stderr).toContain(
    "no-restricted-imports",
  );

  const complex = await createProject("complex");
  const complexResult = await runLint(complex);
  expect(complexResult.exitCode).toBe(0);
}, 120_000);

for (const [module, stream, local] of [
  ["node:process", "stdout", "stdout"],
  ["node:process", "stderr", "errorStream"],
  ["process", "stdout", "outputStream"],
  ["process", "stderr", "stderr"],
]) {
  test(`typed ESLint rejects named process stream ${module}:${stream}`, async () => {
    const root = await createProject("simple");
    await mkdir(join(root, "src/domains"), { recursive: true });
    const path = join(root, "src/domains/stream.ts");
    await writeFile(
      path,
      `import { ${stream} as ${local} } from "${module}";\n${local}.write("forbidden output");\n`,
    );
    const rejected = await runLint(root);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain(
      "repository/no-domain-output",
    );
    await writeFile(path, 'export const output = "returned domain data";\n');
    expect((await runLint(root)).exitCode).toBe(0);
  }, 120_000);
}

for (const method of ["error", "warn"] as const) {
  test(`typed ESLint forbids owner console.${method}`, async () => {
    const root = await createProject("simple");
    await writeFile(
      join(root, "src/cli.ts"),
      SIMPLE_SOURCE["src/cli.ts"] +
        `\nconsole.${method}("forbidden output");\n`,
    );
    const result = await runLint(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("no-console");
  }, 120_000);
}

for (const specimen of [
  {
    file: "src/engine.ts",
    source: COMPLEX_SOURCE["src/engine.ts"],
    statement: 'import { spawn } from "node:child_process";\nvoid spawn;\n',
  },
  {
    file: "src/cli.ts",
    source: COMPLEX_SOURCE["src/cli.ts"],
    statement:
      'import { getLogger } from "@logtape/logtape";\nvoid getLogger;\n',
  },
]) {
  test(`typed ESLint forbids complex restricted import: ${specimen.file}`, async () => {
    const root = await createProject("complex");
    await writeFile(
      join(root, specimen.file),
      specimen.source + specimen.statement,
    );
    const result = await runLint(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("no-restricted-imports");
  }, 120_000);
}
