import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const scratchRoots: string[] = [];

const GENERATED_CI = `name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - run: bun install --frozen-lockfile
      - run: bun run check
`;

const STARTER_FILES = {
  simple: [
    ".cli-design-template.json",
    "eslint-rules.mjs",
    "AGENTS.md",
    "eslint.config.mjs",
    "src/commands-contract.ts",
    "src/commands.ts",
    "src/domains/status.ts",
    "src/domains/result.ts",
    "src/domains/template.ts",
    ".fallowrc.json",
    ".github/workflows/ci.yml",
    ".gitignore",
    "README.md",
    "biome.json",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "src/cli.ts",
    "tests/cli.test.ts",
    "tsconfig.base.json",
    "tsconfig.json",
  ],
  complex: [
    ".cli-design-template.json",
    "eslint-rules.mjs",
    "AGENTS.md",
    "eslint.config.mjs",
    "src/commands-contract.ts",
    "src/commands.ts",
    "src/domains/state.ts",
    "src/diagnostics-custody.ts",
    ".fallowrc.json",
    ".github/workflows/ci.yml",
    ".gitignore",
    "README.md",
    "biome.json",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "src/branch-station-catalog.ts",
    "src/cli.ts",
    "src/command-contract.ts",
    "src/diagnostics.ts",
    "src/engine.ts",
    "src/journal.ts",
    "src/model.ts",
    "src/process-lifecycle.ts",
    "src/runtime.ts",
    "tests/catalog/catalog.test.ts",
    "tests/integration/integration.test.ts",
    "tests/unit/unit.test.ts",
    "tsconfig.base.json",
    "tsconfig.json",
  ],
} as const;

// Independent oracle: these are the public CLI wording expectations.
const SOURCE_PACKET_DATA_MESSAGE =
  "HTTP(S) source packet URLs must not contain username, password, or query data";
const SOURCE_PACKET_DATA_REPAIR =
  "remove username, password, or query data, or use an absolute local packet path";

function parsePackage(text: string) {
  const value: unknown = JSON.parse(text);
  return value as {
    name: string;
    packageManager: string;
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    catalog: Record<string, string>;
  };
}

interface Invocation {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function runIn(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Invocation {
  return runCommand(cwd, [process.execPath, ...args], env);
}

function runCommand(
  cwd: string,
  command: string[],
  env: Record<string, string> = {},
): Invocation {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function invoke(...args: string[]): Invocation {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/bootstrap.ts", ...args],
    {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/bun-typescript-template-test-");
  scratchRoots.push(root);
  return root;
}

function expectRejectedSourcePacket(
  root: string,
  name: string,
  packet: string,
  redactedParts: readonly string[],
): void {
  const destination = join(root, name);
  const result = invoke(
    "--profile",
    "scratch",
    "--destination",
    destination,
    "--source-packet",
    packet,
    "--json",
  );

  expect(result.exitCode).toBe(2);
  for (const value of [packet, ...redactedParts]) {
    expect(result.stdout).not.toContain(value);
    expect(result.stderr).not.toContain(value);
  }
  expect(JSON.parse(result.stderr)).toMatchObject({
    error: {
      code: "invalid_source_packet",
      message: SOURCE_PACKET_DATA_MESSAGE,
      repair: SOURCE_PACKET_DATA_REPAIR,
      retrySafe: true,
    },
    status: "refused",
  });
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(join(destination, "README.md"))).toBe(false);
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

function requireSuccess(result: Invocation, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit ${result.exitCode}: ${result.stderr}\n${result.stdout}`,
    );
  }
}

function commitGeneratedFiles(
  destination: string,
  files: readonly string[],
): void {
  requireSuccess(
    runCommand(destination, ["git", "init", "--quiet"]),
    "git init",
  );
  requireSuccess(
    runCommand(destination, ["git", "add", "--", ...files]),
    "git add generated files",
  );
  requireSuccess(
    runCommand(destination, [
      "git",
      "-c",
      "user.name=CLI template qualification",
      "-c",
      "user.email=cli-template@example.test",
      "commit",
      "--quiet",
      "-m",
      "qualify generated starter",
    ]),
    "git commit generated files",
  );
}

afterEach(async () => {
  await Promise.all(
    scratchRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("public bootstrap CLI", () => {
  test("shows useful help with no arguments", () => {
    const result = invoke();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--profile scratch");
    expect(result.stdout).toContain("--profile durable");
  });

  test("generates scratch without Fallow", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "scratch-example");
    const packet = "https://example.test/vault/projects/%7Escratch-example/";
    const result = invoke(
      "--profile",
      "scratch",
      "--destination",
      destination,
      "--source-packet",
      packet,
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      profile: "scratch",
      sourcePacket: packet,
      status: "created",
    });
    const files = await listFiles(destination);
    const packageJson = parsePackage(
      await readFile(join(destination, "package.json"), "utf8"),
    );
    expect(packageJson.scripts).not.toHaveProperty("quality:fallow");
    expect(packageJson.devDependencies ?? {}).not.toHaveProperty("fallow");
    expect(files.some((file) => file.toLowerCase().includes("fallow"))).toBe(
      false,
    );
    expect(files).not.toContain("TEMPLATE-SOURCE.md");
    expect(await readFile(join(destination, "README.md"), "utf8")).toContain(
      packet,
    );

    const sentinelDirectory = join(root, "sentinel-bin");
    const sentinelPath = join(sentinelDirectory, "fallow");
    const invocationMarker = join(root, "fallow-invoked");
    await mkdir(sentinelDirectory);
    await writeFile(
      sentinelPath,
      '#!/bin/sh\nprintf "%s\\n" invoked > "$FALLOW_SENTINEL"\nexit 97\n',
    );
    await chmod(sentinelPath, 0o755);
    const runtimeEnv = {
      FALLOW_SENTINEL: invocationMarker,
      PATH: `${sentinelDirectory}:${process.env.PATH ?? ""}`,
    };
    for (const command of [
      ["install", "--frozen-lockfile"],
      ["run", "start", "--", "status"],
      ["run", "check"],
    ]) {
      const commandResult = runIn(destination, command, runtimeEnv);
      requireSuccess(commandResult, command.join(" "));
    }
    expect(await Bun.file(invocationMarker).exists()).toBe(false);
  });

  test("rejects username-only source packets before writing or output", async () => {
    const root = await temporaryRoot();
    expectRejectedSourcePacket(
      root,
      "username",
      "https://demo@example.test/vault/projects/example/",
      ["demo"],
    );
  });

  test("rejects password-only source packets before writing or output", async () => {
    const root = await temporaryRoot();
    expectRejectedSourcePacket(
      root,
      "password",
      "https://:secret@example.test/",
      ["secret"],
    );
  });

  test("rejects query source packets before writing or output", async () => {
    const root = await temporaryRoot();
    expectRejectedSourcePacket(
      root,
      "query",
      "https://example.test/vault/projects/example/?access=example-only",
      ["access=example-only"],
    );
  });

  test("generates and checks durable single-package and optional monorepo variants", async () => {
    const root = await temporaryRoot();
    for (const [name, extra, variant] of [
      ["durable-single", [], "single-package"],
      ["durable-monorepo", ["--monorepo"], "monorepo"],
    ] as const) {
      const destination = join(root, name);
      const packet = `https://example.test/vault/projects/${name}/`;
      const result = invoke(
        "--profile",
        "durable",
        "--destination",
        destination,
        "--source-packet",
        packet,
        ...extra,
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        profile: "durable",
        status: "created",
        variant,
      });
      const generatedFiles = await listFiles(destination);
      const packageJson = parsePackage(
        await readFile(join(destination, "package.json"), "utf8"),
      );
      const readme = await readFile(join(destination, "README.md"), "utf8");
      expect(packageJson.name).toBe(name);
      expect(packageJson.packageManager).toBe("bun@1.4.4");
      expect(packageJson.devDependencies["@biomejs/biome"]).toBe("2.6.7");
      expect(packageJson.devDependencies.fallow).toBe("3.43.0");
      if (variant === "monorepo") {
        expect(packageJson.catalog.typescript).toBe("npm:typescript@7.0.2");
        expect(packageJson.catalog["@types/bun"]).toBe("1.4.0");
        expect(packageJson.devDependencies.typescript).toBe(
          "npm:@typescript/typescript6@6.0.2",
        );
      } else {
        expect(packageJson.devDependencies.typescript).toBe(
          "npm:@typescript/typescript6@6.0.2",
        );
        expect(packageJson.devDependencies["@types/bun"]).toBe("1.4.0");
      }
      expect(generatedFiles).not.toContain("TEMPLATE-SOURCE.md");
      expect(readme).toContain(packet);
      expect(readme).not.toContain("__SOURCE_PACKET__");
      expect(readme).not.toContain("profiles/durable");

      expect(
        runCommand(ROOT, ["git", "-C", destination, "init", "-b", "main"])
          .exitCode,
      ).toBe(0);
      expect(
        runCommand(ROOT, [
          "git",
          "-C",
          destination,
          "-c",
          "user.name=Bootstrap Test",
          "-c",
          "user.email=bootstrap@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "chore: establish comparison base",
        ]).exitCode,
      ).toBe(0);
      expect(
        runIn(destination, ["install", "--frozen-lockfile"], {}).exitCode,
      ).toBe(0);
      const check = runIn(destination, ["run", "check"], {});
      requireSuccess(check, "durable generated check");
      expect(check.stdout).toContain('"verdict":"pass"');
      if (variant === "monorepo") {
        const testPath = join(destination, "tests/cli.test.ts");
        const original = await readFile(testPath, "utf8");
        await writeFile(
          testPath,
          original +
            '\ntest("root CLI tests are executed", () => { throw new Error("ROOT_CLI_TEST_SENTINEL"); });\n',
        );
        const failed = runIn(destination, ["run", "test"], {});
        expect(failed.exitCode).not.toBe(0);
        expect(failed.stderr).toContain("ROOT_CLI_TEST_SENTINEL");
        await writeFile(testPath, original);
      }
    }
  }, 120_000);

  test("refuses a non-empty destination without changing its bytes", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "owned");
    const sentinel = join(destination, "keep.txt");
    await mkdir(destination);
    await writeFile(sentinel, "keep these bytes\n");
    const before = createHash("sha256")
      .update(await readFile(sentinel))
      .digest("hex");
    const result = invoke(
      "--profile",
      "scratch",
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/vault/projects/owned/",
      "--json",
    );
    const after = createHash("sha256")
      .update(await readFile(sentinel))
      .digest("hex");

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "refused",
      error: { code: "destination_not_empty", retrySafe: true },
    });
    expect(after).toBe(before);
    expect(await listFiles(destination)).toEqual(["keep.txt"]);
  });

  test("rejects the monorepo option for scratch", async () => {
    const root = await temporaryRoot();
    const result = invoke(
      "--profile",
      "scratch",
      "--destination",
      join(root, "invalid"),
      "--source-packet",
      "https://example.test/vault/projects/invalid/",
      "--monorepo",
      "--json",
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "refused",
      error: { code: "profile_option_mismatch", retrySafe: true },
    });
  });

  test("generates independently runnable simple and complex CLI starters", async () => {
    const root = await temporaryRoot();
    for (const starter of ["simple", "complex"] as const) {
      const destination = join(root, `${starter}-cli`);
      const result = invoke(
        "--profile",
        "durable",
        "--starter",
        starter,
        "--destination",
        destination,
        "--source-packet",
        `https://example.test/vault/projects/${starter}-cli/`,
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        profile: "durable",
        starter,
        status: "created",
        variant: "single-package",
      });
      const files = await listFiles(destination);
      expect(files).toEqual([...STARTER_FILES[starter]].sort());
      expect(
        await readFile(join(destination, ".github/workflows/ci.yml"), "utf8"),
      ).toBe(GENERATED_CI);
      expect(await readFile(join(destination, "README.md"), "utf8")).toContain(
        "https://example.test/vault/projects/",
      );

      expect(
        runIn(destination, ["install", "--frozen-lockfile"], {}).exitCode,
      ).toBe(0);
      const machine = runIn(
        destination,
        ["run", "--silent", "start", "--", "status", "--json"],
        {},
      );
      expect(machine.exitCode).toBe(0);
      expect(machine.stderr).toBe("");
      expect(JSON.parse(machine.stdout)).toMatchObject({
        contractVersion: "2.0.0",
        envelopeVersion: 2,
        result: { outcome: "success", transactionState: "unchanged" },
      });

      const help = runIn(
        destination,
        ["run", "--silent", "start", "--", "--help"],
        {},
      );
      expect(help.exitCode).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain("Usage: example");
      if (starter === "complex") expect(help.stdout).toContain("recover");

      const discovery = runIn(
        destination,
        [
          "run",
          "--silent",
          "start",
          "--",
          "--discover-command",
          "example.status",
          "--json",
        ],
        {},
      );
      expect(discovery.exitCode).toBe(0);
      expect(discovery.stderr).toBe("");
      expect(JSON.parse(discovery.stdout)).toMatchObject({
        result: {
          data: {
            command: { commandIdentity: "example.status" },
            semantics: "possible-outcomes",
          },
        },
      });

      commitGeneratedFiles(destination, STARTER_FILES[starter]);
      const freshCheckout = join(root, `${starter}-fresh-checkout`);
      requireSuccess(
        runCommand(root, [
          "git",
          "clone",
          "--quiet",
          destination,
          freshCheckout,
        ]),
        "git clone generated starter",
      );
      expect(existsSync(join(freshCheckout, "node_modules"))).toBe(false);
      expect(
        runIn(freshCheckout, ["install", "--frozen-lockfile"], {}).exitCode,
      ).toBe(0);
      requireSuccess(
        runIn(freshCheckout, ["run", "check"], {}),
        "fresh generated check",
      );
      expect(
        runCommand(freshCheckout, ["git", "status", "--short"]).stdout,
      ).toBe("");
    }
  }, 120_000);

  test("refuses incompatible starter profile combinations before writing", async () => {
    const root = await temporaryRoot();
    for (const args of [
      ["--profile", "scratch", "--starter", "simple"],
      ["--profile", "durable", "--starter", "complex", "--monorepo"],
    ]) {
      const destination = join(root, `refused-${args.join("-")}`);
      const result = invoke(
        ...args,
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/vault/projects/refused/",
        "--json",
      );
      expect(result.exitCode).toBe(2);
      expect(existsSync(destination)).toBe(false);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "profile_option_mismatch" },
        status: "refused",
      });
    }
  });
});

function admitCli(root: string): Invocation {
  return runCommand(ROOT, [
    process.execPath,
    "run",
    "src/cli-inventory.ts",
    root,
  ]);
}

test("one-CLI admission covers scratch, durable and workspace entry points", async () => {
  for (const [profile, extra] of [
    ["scratch", []],
    ["durable", []],
    ["durable", ["--monorepo"]],
  ] as const) {
    const root = await temporaryRoot();
    const destination = join(root, "repository");
    requireSuccess(
      invoke(
        "--profile",
        profile,
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/spec",
        ...extra,
        "--json",
      ),
      "generate repository",
    );
    await writeFile(
      join(destination, "src/args.ts"),
      "export function cliArgs() { return process.argv.slice(2); }\n",
    );
    const entryPath = join(destination, "src/cli.ts");
    await writeFile(
      entryPath,
      'import { cliArgs } from "./args.ts";\nvoid cliArgs;\n' +
        (await readFile(entryPath, "utf8")),
    );
    const initial = admitCli(destination);
    expect(initial.exitCode).toBe(0);
    expect(JSON.parse(initial.stdout)).toMatchObject({
      entries: ["src/cli.ts"],
      status: "admitted",
    });
    const manifestPath = join(destination, "package.json");
    const manifest = parsePackage(await readFile(manifestPath, "utf8"));
    manifest.scripts["cli-alias"] = "bun run ./src/cli.ts --help";
    manifest.scripts["build:sample"] =
      "bun build src/cli.ts --outfile dist/cli.js";
    manifest.scripts["build:custom"] = "bun run scripts/build.ts";
    await mkdir(join(destination, "scripts"));
    await writeFile(
      join(destination, "scripts/build.ts"),
      'const minify = process.argv.includes("--minify");\nvoid Bun.build({entrypoints: ["src/cli.ts"], outdir: "dist", minify});\n',
    );
    await writeFile(
      join(destination, "BUILD.md"),
      "Build with `bun run scripts/build.ts --minify`.\n",
    );
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    expect(admitCli(destination).exitCode).toBe(0);
    await writeFile(
      join(destination, "src/second.ts"),
      'if (import.meta.main) process.stdout.write("second CLI\\n");\n',
    );
    const refused = admitCli(destination);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      entries: ["src/cli.ts", "src/second.ts"],
      status: "refused",
    });
  }
});

test("one-CLI admission finds a documented executable and workspace bin", async () => {
  const root = await temporaryRoot();
  const destination = join(root, "workspace");
  requireSuccess(
    invoke(
      "--profile",
      "durable",
      "--monorepo",
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ),
    "generate workspace",
  );
  await writeFile(
    join(destination, "src/documented.ts"),
    'process.stdout.write("documented CLI\\n");\n',
  );
  const readme = join(destination, "README.md");
  await writeFile(
    readme,
    (await readFile(readme, "utf8")) +
      "\nAdditional application: `bun run src/documented.ts`.\n",
  );
  expect(admitCli(destination).exitCode).toBe(1);
  await writeFile(
    join(destination, "src/documented.ts"),
    "export const libraryValue = 1;\n",
  );
  await writeFile(readme, "# Workspace\nRun: `bun run src/cli.ts`.\n");
  const memberPath = join(destination, "packages/example-lib/package.json");
  const member = JSON.parse(await readFile(memberPath, "utf8")) as Record<
    string,
    unknown
  >;
  member.bin = { extra: "src/index.ts" };
  await writeFile(memberPath, JSON.stringify(member, null, 2) + "\n");
  const refused = admitCli(destination);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    entries: ["packages/example-lib/src/index.ts", "src/cli.ts"],
  });
});

test("domain loading failures preserve help, discovery and unrelated commands", async () => {
  const root = await temporaryRoot();
  const destination = join(root, "domains");
  requireSuccess(
    invoke(
      "--profile",
      "scratch",
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ),
    "generate domain specimen",
  );
  await writeFile(
    join(destination, "src/domains/status.ts"),
    'throw new Error("provider configuration unavailable");\nexport function inspectStatus(): never { throw new Error("unavailable"); }\n',
  );
  for (const args of [
    ["--help", "--json"],
    ["--discover", "--json"],
    ["template", "info", "--json"],
  ]) {
    const result = runIn(
      destination,
      ["run", "--silent", "start", "--", ...args],
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  }
  const unavailable = runIn(
    destination,
    ["run", "--silent", "start", "--", "status", "--json"],
    {},
  );
  expect(unavailable.exitCode).toBe(1);
  expect(unavailable.stderr).toBe("");
  expect(JSON.parse(unavailable.stdout)).toMatchObject({
    result: {
      commandIdentity: "example.status",
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      transactionState: "unchanged",
    },
  });
});

test("lint, local rules, formatting and native type errors fail independent read-only checks", async () => {
  const root = await temporaryRoot();
  const destination = join(root, "gates");
  requireSuccess(
    invoke(
      "--profile",
      "durable",
      "--starter",
      "simple",
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ),
    "generate gate specimen",
  );
  requireSuccess(
    runIn(destination, ["install", "--frozen-lockfile"], {}),
    "install gate specimen",
  );
  requireSuccess(
    runIn(destination, ["run", "lint"], {}),
    "positive lint and local rule control",
  );
  const path = join(destination, "src/domains/status.ts");
  const original = await readFile(path, "utf8");
  const mutations = [
    {
      source: original + '\nprocess.stdout.write("forbidden");\n',
      phase: "lint",
      diagnostic: "repository/no-domain-output",
    },
    {
      source: original + "\nexport const unsafe: any = 1;\n",
      phase: "lint",
      diagnostic: "@typescript-eslint/no-explicit-any",
    },
    {
      source: original + "\n\n",
      phase: "format:check",
      diagnostic: "Formatter would have printed",
    },
    {
      source: "export function inspectStatus(): string {\n  return 42;\n}\n",
      phase: "typecheck",
      diagnostic: "TS2322",
    },
  ];
  for (const mutation of mutations) {
    await writeFile(path, mutation.source);
    const result = runIn(destination, ["run", "check"], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      `script "${mutation.phase}" exited with code 1`,
    );
    expect(result.stdout + result.stderr).toContain(mutation.diagnostic);
    expect(await readFile(path, "utf8")).toBe(mutation.source);
  }
}, 120_000);
