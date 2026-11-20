import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  commitIn,
  gitEnv,
  gitOutput,
  inherited,
  initRepository,
} from "../support/git-fixture.ts";
import { testFolder } from "../support/test-folder.ts";
import { spawnBounded } from "./kernel-repair/swarm-process.ts";

const repository = join(import.meta.dir, "../..");
const installBound = 120_000;
const buildBound = 60_000;
const stagingBound = 60_000;
const copyBound = 2 * stagingBound + 60_000;
const setupBound = installBound + 2 * buildBound + copyBound;
const runBound = 30_000;
const testBound = runBound + 30_000;

function gitStaging(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: stagingBound,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${args.join(" ")} did not exit within ${stagingBound} ms.`,
    );
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string.");
  return value;
}

const manifest = record(
  JSON.parse(readFileSync(join(repository, "package.json"), "utf8")),
);
const devDependencies = record(manifest.devDependencies);
const exportNames = Object.keys(record(manifest.exports ?? {}));

type Ran = Awaited<ReturnType<typeof spawnBounded>>;
const world: {
  base: string;
  kernel: string;
  consumer: string;
  commit: string;
  bundle?: Ran;
  binary?: Ran;
} = { base: "", kernel: "", consumer: "", commit: "" };
const environment = { ...inherited(), ...gitEnv };

async function run(
  argv: readonly string[],
  cwd: string,
  boundMilliseconds = runBound,
) {
  return spawnBounded(argv, { cwd, env: environment, boundMilliseconds });
}

function workingTreeCommit(source: string, destination: string): string {
  const paths = gitOutput(source, "ls-files", "-z")
    .split("\0")
    .filter((path) => path !== "");
  const copied: string[] = [];
  for (const path of paths) {
    const from = join(source, path);
    const to = join(destination, path);
    let facts;
    try {
      facts = lstatSync(from);
    } catch (error) {
      if (Reflect.get(Object(error), "code") === "ENOENT") continue;
      throw error;
    }
    mkdirSync(dirname(to), { recursive: true });
    if (facts.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
    copied.push(path);
  }
  gitOutput(destination, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(destination, ".pathspec"), copied.join("\0"));
  gitStaging(
    destination,
    "add",
    "--pathspec-from-file=.pathspec",
    "--pathspec-file-nul",
  );
  gitStaging(destination, "commit", "--quiet", "-m", "working tree");
  return gitOutput(destination, "rev-parse", "HEAD").trim();
}

const noAddOnCli = `import { command, contractFor, runProcess } from "agent-cli-kernel";

const noEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const input = (options: readonly object[]) => ({
  arguments: [],
  options,
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
});

const status = command({
  identity: "bare.status",
  route: ["status"],
  summary: "Report that this command-line tool runs.",
  input: input([]),
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "bare.status", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The tool runs.", data: { ready: true }, effects: noEffects },
    ),
});

const match = command({
  identity: "bare.match",
  route: ["match"],
  summary: "Accept a name that matches a pattern.",
  input: input([
    {
      name: "--name",
      aliases: [],
      summary: "A lower-case name.",
      required: true,
      repeatable: false,
      value: { kind: "string", minLength: 1, maxLength: 64, choices: null, pattern: "[a-z]+" },
    },
  ]),
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "bare.match", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The name matches.", data: { matched: true }, effects: noEffects },
    ),
});

await runProcess(
  contractFor({ cli: "bare", commands: [status, match], installedAddons: [] }),
)(process.argv.slice(2));
`;

const importEveryExport = `const names = JSON.parse(process.argv[2] ?? "[]");
const loaded = {};
for (const name of names) {
  const specifier = name === "." ? "agent-cli-kernel" : \`agent-cli-kernel/\${name.slice(2)}\`;
  const module = specifier.endsWith(".json")
    ? await import(specifier, { with: { type: "json" } })
    : await import(specifier);
  loaded[name] = Object.keys(module).length;
}
const deep = await import("agent-cli-kernel/kernel/src/kernel/index.ts").then(
  () => "imported",
  (error) => (error instanceof Error ? error.message : String(error)),
);
console.log(JSON.stringify({ loaded, deep }));
`;

beforeAll(async () => {
  world.base = testFolder("pinned-commit-");
  world.kernel = join(world.base, "kernel");
  world.consumer = join(world.base, "consumer");
  world.commit = workingTreeCommit(repository, world.kernel);
  mkdirSync(join(world.consumer, "src"), { recursive: true });
  const dev = ["@eslint/js", "typescript-eslint", "eslint", "typescript"];
  writeFileSync(
    join(world.consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "pinned-commit-consumer",
        private: true,
        type: "module",
        dependencies: {
          "agent-cli-kernel": `git+file://${world.kernel}#${world.commit}`,
        },
        devDependencies: Object.fromEntries(
          dev.map((name) => [name, text(devDependencies[name])]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(world.consumer, "bunfig.toml"),
    '[install]\nauto = "disable"\n',
  );
  writeFileSync(join(world.consumer, "src/cli.ts"), noAddOnCli);
  writeFileSync(join(world.consumer, "src/imports.ts"), importEveryExport);
  const installed = await run(
    [process.execPath, "install"],
    world.consumer,
    installBound,
  );
  if (installed.exit !== 0)
    throw new Error(
      `bun install failed:\n${installed.stdout}${installed.stderr}`,
    );
  world.bundle = await run(
    [
      process.execPath,
      "build",
      "src/cli.ts",
      "--target",
      "bun",
      "--outdir",
      "dist",
      "--metafile=dist/bundle-meta.json",
    ],
    world.consumer,
    buildBound,
  );
  world.binary = await run(
    [
      process.execPath,
      "build",
      "--compile",
      "src/cli.ts",
      "--outfile",
      "dist/bare",
      "--metafile=dist/binary-meta.json",
    ],
    world.consumer,
    buildBound,
  );
}, setupBound);

afterAll(() => {
  if (world.base !== "") rmSync(world.base, { recursive: true, force: true });
});

test("the kernel repository's manifest names agent-cli-kernel, is a module with no version or prepare, and exports the kernel, four add-ons, lint, lint rules, the declaration and itself", () => {
  expect(manifest.name).toBe("agent-cli-kernel");
  expect(manifest.type).toBe("module");
  expect(Object.hasOwn(manifest, "version")).toBe(false);
  expect(Object.hasOwn(record(manifest.scripts), "prepare")).toBe(false);
  expect(exportNames).toEqual([
    ".",
    "./addons/approval",
    "./addons/diagnostics",
    "./addons/programs",
    "./addons/state",
    "./lint",
    "./lint-rules",
    "./kernel-declaration.json",
    "./package.json",
  ]);
  expect(Object.keys(record(manifest.dependencies))).toEqual([
    "@logtape/logtape",
    "@logtape/redaction",
  ]);
});

test(
  "a repository installs the kernel by name at a pinned commit, imports every export, and is refused a deep import",
  async () => {
    const imported = await run(
      [process.execPath, "src/imports.ts", JSON.stringify(exportNames)],
      world.consumer,
    );
    expect(imported.stderr).toBe("");
    expect(imported.exit).toBe(0);
    const { loaded, deep } = record(JSON.parse(imported.stdout));
    const counts = record(loaded);
    expect(Object.keys(counts)).toEqual(exportNames);
    expect(exportNames.filter((name) => !(Number(counts[name]) > 0))).toEqual(
      [],
    );
    expect(
      existsSync(
        join(
          world.consumer,
          "node_modules/agent-cli-kernel/kernel/src/kernel/index.ts",
        ),
      ),
    ).toBe(true);
    expect(text(deep)).toStartWith(
      "Cannot find package 'agent-cli-kernel' imported from ",
    );
  },
  setupBound,
);

function metafileInputs(path: string): readonly string[] {
  return Object.keys(
    record(record(JSON.parse(readFileSync(path, "utf8"))).inputs),
  );
}

function expectKernelOnly(inputs: readonly string[]): void {
  expect(inputs.some((path) => path.includes("kernel/src/kernel/"))).toBe(true);
  expect(
    inputs.filter(
      (path) =>
        path.includes("kernel/src/addons/") || path.includes("@logtape"),
    ),
  ).toEqual([]);
}

test(
  "a CLI with no add-on bundles with no add-on file and no @logtape, and runs from the bundle",
  async () => {
    expect(world.bundle?.exit).toBe(0);
    expectKernelOnly(
      metafileInputs(join(world.consumer, "dist/bundle-meta.json")),
    );
    const ran = await run(
      [process.execPath, "dist/cli.js", "status", "--json"],
      world.consumer,
    );
    expect(ran.exit).toBe(0);
    expect(ran.stdout).toContain("SUCCESS_UNCHANGED");
  },
  testBound,
);

test(
  "a CLI with no add-on compiles to a binary with no add-on file and no @logtape, and the binary runs",
  async () => {
    expect(world.binary?.exit).toBe(0);
    expectKernelOnly(
      metafileInputs(join(world.consumer, "dist/binary-meta.json")),
    );
    const ran = await run(
      [join(world.consumer, "dist/bare"), "status", "--json"],
      world.consumer,
    );
    expect(ran.exit).toBe(0);
    expect(ran.stdout).toContain("SUCCESS_UNCHANGED");
  },
  testBound,
);

test(
  "the installed kernel accepts a pattern-checked option when the CLI runs from source",
  async () => {
    const ran = await run(
      [process.execPath, "src/cli.ts", "match", "--name", "abc", "--json"],
      world.consumer,
    );
    expect(ran.exit).toBe(0);
    expect(ran.stdout).toContain("SUCCESS_UNCHANGED");
  },
  testBound,
);

test(
  "the binary refuses a pattern-checked option as USAGE_INVALID_INVOCATION until K1c moves the pattern worker's source inside input.ts, since no binary carries pattern-worker.ts",
  async () => {
    expect(world.binary?.exit).toBe(0);
    const ran = await run(
      [join(world.consumer, "dist/bare"), "match", "--name", "abc", "--json"],
      world.consumer,
    );
    expect(ran.exit).not.toBe(0);
    expect(ran.stdout).toContain("USAGE_INVALID_INVOCATION");
    expect(ran.stdout).toContain(
      "The option --name could not be checked because its declared pattern is not valid.",
    );
    expect(ran.stdout).not.toContain("SUCCESS_UNCHANGED");
  },
  testBound,
);

test(
  "the working-tree copy commits only the tracked files the working tree still holds",
  () => {
    const source = testFolder("pinned-commit-source-");
    const destination = testFolder("pinned-commit-copy-");
    try {
      initRepository(source);
      commitIn(source, "two files", {
        "kept.txt": "kept\n",
        "gone.txt": "gone\n",
      });
      rmSync(join(source, "gone.txt"));
      const commit = workingTreeCommit(source, destination);
      expect(
        gitOutput(destination, "ls-tree", "-r", "--name-only", commit).trim(),
      ).toBe("kept.txt");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  },
  copyBound,
);
