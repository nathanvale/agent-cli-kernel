import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repository = join(import.meta.dir, "..");
const scripts = [
  "scripts/doctor.ts",
  "scripts/test-area.ts",
  "src/toolchain-resolution.ts",
];
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) rmSync(project, { recursive: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function project(manifest: object, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  projects.push(root);
  for (const path of scripts) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  write(root, "package.json", JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files))
    write(root, path, content);
  return root;
}

function installedToolchain(lintVersion: string): Record<string, string> {
  return {
    "node_modules/typescript-eslint/package.json":
      '{"name":"typescript-eslint","main":"index.js"}',
    "node_modules/typescript-eslint/index.js": "module.exports = {};",
    "node_modules/typescript/package.json": `{"name":"typescript","version":"${lintVersion}","main":"index.js"}`,
    "node_modules/typescript/index.js": `module.exports = { version: "${lintVersion}" };`,
    "node_modules/@typescript/native/package.json": '{"version":"7.0.2"}',
    "node_modules/fallow-type-aware/package.json":
      '{"name":"fallow-type-aware","version":"3.43.0"}',
    "node_modules/fallow-type-aware/node_modules/typescript/package.json":
      '{"version":"7.0.2"}',
    "node_modules/.bin/tsc": "#!/bin/sh\necho 'Version 7.0.2'\n",
  };
}

function withToolchain(
  lintVersion: string,
  files: Record<string, string> = {},
) {
  const root = project(
    { packageManager: `bun@${Bun.version}` },
    { ...installedToolchain(lintVersion), ...files },
  );
  chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
  return root;
}

function run(root: string, script: string, args: string[] = [], cwd = root) {
  const result = Bun.spawnSync(
    [process.execPath, join(root, script), ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    lines: result.stdout.toString().split("\n"),
  };
}

const doctor = "scripts/doctor.ts";
const testArea = "scripts/test-area.ts";

describe("doctor", () => {
  test("a running Bun other than the pin fails, naming both versions and the repair", () => {
    const result = run(project({ packageManager: "bun@0.0.1" }), doctor);

    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(
      `FAIL bun: found Bun ${Bun.version}, pinned 0.0.1. Repair: install Bun 0.0.1 (mise install bun@0.0.1, or setup-bun in CI), then bun install --frozen-lockfile.`,
    );
  });

  test("a corepack pin with a hash suffix compares only its version", () => {
    const result = run(
      project({ packageManager: `bun@${Bun.version}+sha512.abc` }),
      doctor,
    );

    expect(result.lines).toContain(
      `ok bun: Bun ${Bun.version} matches the packageManager pin.`,
    );
  });

  test.each([
    ["missing", {}],
    ["malformed", { packageManager: "npm@10.0.0" }],
  ])("a %s pin fails with a repair", (_kind, manifest) => {
    const result = run(project(manifest), doctor);

    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(
      'FAIL bun: package.json has no packageManager pin of the form bun@<version>. Repair: add "packageManager": "bun@<version>" to package.json.',
    );
  });

  test("the pinned Bun without node_modules fails with the install repair", () => {
    const result = run(
      project({ packageManager: `bun@${Bun.version}` }),
      doctor,
    );

    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(
      "FAIL toolchain: node_modules is missing. Repair: bun install --frozen-lockfile.",
    );
  });

  test("an empty node_modules fails on one toolchain line ending in the repair", () => {
    const result = run(
      project(
        { packageManager: `bun@${Bun.version}` },
        { "node_modules/.keep": "" },
      ),
      doctor,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(3);
    const toolchainLine = result.lines.find((line) =>
      line.startsWith("FAIL toolchain: "),
    );
    expect(toolchainLine).toEndWith(" Repair: bun install --frozen-lockfile.");
  });

  test("a drifted lint backend fails the toolchain check", () => {
    const result = run(withToolchain("6.0.3"), doctor);

    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(
      "FAIL toolchain: The installed lint, compiler and semantic backends do not match the accepted toolchain. Repair: bun install --frozen-lockfile.",
    );
  });

  test("the accepted toolchain passes from any working directory", () => {
    const root = withToolchain("6.0.2");
    const result = run(root, doctor, [], join(root, "scripts"));

    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain(
      `ok bun: Bun ${Bun.version} matches the packageManager pin.`,
    );
    expect(result.lines).toContain(
      "ok toolchain: node_modules resolves the accepted lint, compiler and semantic backends.",
    );
  });
});

describe("test:area", () => {
  const probe = {
    "tests/contract3/probe/probe.test.ts":
      'import { test } from "bun:test";\ntest("chosen case", () => {});\ntest("other case", () => {});\n',
    "tests/contract3/probe-seam.test.ts":
      'import { test } from "bun:test";\ntest("chosen seam case", () => {});\n',
  };

  test("an unknown area exits 2 listing the areas found on disk from any working directory", () => {
    const root = withToolchain("6.0.2", probe);
    const result = run(root, testArea, ["nope"], join(root, "scripts"));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      'Usage: bun run test:area <area> [bun test options]. Unknown area "nope". Valid areas: kernel, probe.\n',
    );
  });

  test("an area runs only its own folder and passes options to bun test", () => {
    const result = run(withToolchain("6.0.2", probe), testArea, [
      "probe",
      "-t",
      "chosen",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(" 1 pass\n");
    expect(result.stderr).toContain(" 1 filtered out\n");
    expect(result.stderr).toContain("Ran 1 test across 1 file.");
  });
});
