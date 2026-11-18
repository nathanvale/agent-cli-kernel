import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveToolchain } from "../../../src/toolchain-resolution.ts";

const roots: string[] = [];
const repository = resolve(import.meta.dir, "../../..");

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function installedProject(apiVersion: string, packageVersion = "6.0.2") {
  const root = await mkdtemp(join(tmpdir(), "toolchain-resolution-"));
  roots.push(root);
  const files = {
    "package.json": "{}",
    "node_modules/typescript-eslint/package.json": '{"main":"index.cjs"}',
    "node_modules/typescript-eslint/index.cjs": "module.exports = {};",
    "node_modules/typescript/package.json": JSON.stringify({
      version: packageVersion,
      main: "index.cjs",
    }),
    "node_modules/typescript/index.cjs": `module.exports = ${JSON.stringify({ version: apiVersion })};`,
    "node_modules/@typescript/native/package.json": '{"version":"7.0.2"}',
    "node_modules/fallow-type-aware/package.json":
      '{"name":"fallow-type-aware"}',
    "node_modules/fallow-type-aware/node_modules/typescript/package.json":
      '{"version":"7.0.2"}',
  };
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await mkdir(join(root, "node_modules/.bin"));
  await symlink(
    join(repository, "node_modules/.bin/tsc"),
    join(root, "node_modules/.bin/tsc"),
  );
  return root;
}

test("toolchain admission rejects a newer API hidden behind the accepted wrapper", async () => {
  const project = await installedProject("6.0.3");
  expect(() => resolveToolchain(project)).toThrow("accepted toolchain");
});

test("toolchain admission accepts the exact API and wrapper with the native compiler", async () => {
  const project = await installedProject("6.0.2");
  expect(resolveToolchain(project)).toMatchObject({
    lint: "6.0.2",
    compiler: "7.0.2",
    semantic: "7.0.2",
    compilerExecutable: "Version 7.0.2",
  });
});

test("toolchain admission rejects a version the module only inherits", async () => {
  const project = await installedProject("6.0.2");
  await writeFile(
    join(project, "node_modules/typescript/index.cjs"),
    'module.exports = Object.create({ version: "6.0.2" });',
  );
  expect(() => resolveToolchain(project)).toThrow(
    "The installed package has no version identity.",
  );
});

test("toolchain admission still rejects a wrong wrapper even with the accepted API", async () => {
  const project = await installedProject("6.0.2", "6.0.3");
  expect(() => resolveToolchain(project)).toThrow("accepted toolchain");
});

test("the installed template resolves the accepted API and native compiler", () => {
  expect(resolveToolchain(repository)).toEqual({
    lint: "6.0.2",
    lintPackage: "6.0.2",
    compiler: "7.0.2",
    semantic: "7.0.2",
    compilerExecutable: "Version 7.0.2",
  });
});
