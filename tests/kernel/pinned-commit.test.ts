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
import { dirname, join, relative } from "node:path";
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
const lintBound = 120_000;
const lintTestBound = lintBound + 30_000;
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

const rootedFileCheck = `import {
  linkSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  readRootedFile,
  type RootedFacts,
  type RootedFileResult,
  type RootedRefusal,
} from "agent-cli-kernel/rooted-file";

const base = process.argv[2] ?? "";
const root = join(base, "root");
const outside = join(base, "outside");
mkdirSync(root, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(root, "plain.txt"), "hello");
symlinkSync(join(root, "plain.txt"), join(root, "link.txt"));
writeFileSync(join(outside, "secret.txt"), "secret");
symlinkSync(outside, join(root, "linked-dir"));
linkSync(join(outside, "secret.txt"), join(root, "hard-link.txt"));
writeFileSync(join(root, "big.txt"), "x".repeat(1025));

const plain: RootedFileResult = readRootedFile(root, "plain.txt", 1024);
const linked: RootedFileResult = readRootedFile(root, "link.txt", 1024);
const linkedFolder: RootedFileResult = readRootedFile(
  root,
  "linked-dir/secret.txt",
  1024,
);
const outsideRoot: RootedFileResult = readRootedFile(
  root,
  "../outside/secret.txt",
  1024,
);
const hardLink: RootedFileResult = readRootedFile(root, "hard-link.txt", 1024);
const overLimit: RootedFileResult = readRootedFile(root, "big.txt", 1024);
let seamCalled = false;
Reflect.apply(readRootedFile, undefined, [
  root,
  "plain.txt",
  1024,
  {
    afterOpen: () => {
      seamCalled = true;
    },
  },
]);

const readFacts: RootedFacts | null =
  plain.kind === "read" ? plain.facts : null;
const asRefusal = (result: RootedFileResult): RootedRefusal | null =>
  result.kind === "refused" ? result : null;
console.log(
  JSON.stringify({
    arity: readRootedFile.length,
    seamCalled,
    realRoot: realpathSync.native(root),
    plain:
      plain.kind === "read"
        ? {
            kind: plain.kind,
            text: new TextDecoder().decode(plain.bytes),
            size: readFacts?.size ?? -1,
          }
        : plain,
    linked: asRefusal(linked),
    linkedFolder: asRefusal(linkedFolder),
    outsideRoot: asRefusal(outsideRoot),
    hardLink: asRefusal(hardLink),
    overLimit: asRefusal(overLimit),
  }),
);
`;

const rootedFileTypes = `import {
  readRootedFile,
  type RootedFacts,
  type RootedFileResult,
  type RootedRefusal,
} from "agent-cli-kernel/rooted-file";

type PublicParameters = Parameters<typeof readRootedFile>;
export const publicArity: PublicParameters["length"] extends 3 ? true : never =
  true;
export function inspectRooted(
  root: string,
): RootedFacts | RootedRefusal | null {
  const result: RootedFileResult = readRootedFile(root, "plain.txt", 1024);
  if (result.kind === "read") return result.facts;
  if (result.kind === "refused") return result;
  return null;
}
`;

const xdgBaseCheck = `import {
  xdgBaseFolder,
  type XdgBaseOptions,
  type XdgKind,
} from "agent-cli-kernel/xdg-base";

const kind: XdgKind = "state";
const noFallback: XdgBaseOptions = { homeFallback: false };
console.log(
  JSON.stringify({
    configured: xdgBaseFolder(
      { XDG_STATE_HOME: "/var/opt//app/./state", HOME: "/home/alice" },
      kind,
    ),
    fallback: xdgBaseFolder({ HOME: "/home/alice" }, "config"),
    ignoredRelative: xdgBaseFolder(
      { XDG_CACHE_HOME: "rel/cache", HOME: "/home/alice" },
      "cache",
    ),
    runtimeUnset: xdgBaseFolder({ HOME: "/home/alice" }, "runtime") ?? null,
    fallbackDisabled:
      xdgBaseFolder({ HOME: "/home/alice" }, "data", noFallback) ?? null,
  }),
);
`;

const consumerLintConfig = `import { kernelLint } from "agent-cli-kernel/lint";

export default kernelLint({
  rootDir: import.meta.dirname,
  srcDir: "src",
  testDirs: [],
  addons: "all",
});
`;

const templateLintConfig = `import { kernelLint } from "agent-cli-kernel/lint";
import kernelRules from "agent-cli-kernel/lint-rules";

const repository = { rules: { ...kernelRules.rules } };

export default kernelLint({
  rootDir: import.meta.dirname,
  srcDir: "src",
  testDirs: [],
  addons: [],
  plugin: repository,
});
`;

const applicationFiles = {
  "src/kernel/process-host.ts":
    'export const out = () => process.stdout.write("x");',
  "src/kernel/index.ts":
    "export const load = (name: string): Promise<unknown> => import(name);",
  "src/kernel/runtime.ts":
    'import { createRequire } from "node:module";\nexport const load = createRequire(import.meta.url);',
  "src/kernel/in.ts": 'export const has = (o: object) => "a" in o;',
  "src/kernel/causes.ts": 'export const code = "DOMAIN_DEADLINE_UNKNOWN";',
  "src/kernel/validation/brand.ts":
    'export const isText = (v: unknown): v is string => typeof v === "string";',
  "src/addons/programs/run.ts": "export const start = Bun.spawn;",
  "src/addons/diagnostics/log.ts":
    'export { getLogger } from "@logtape/logtape";',
  "src/addons/state/linux-flock.ts": 'export { dlopen } from "bun:ffi";',
  "src/app/cause.ts":
    'export const needed = (codes: string[]) => codes.includes("DOMAIN_DEADLINE_UNKNOWN");',
  "src/app/typed.ts": [
    'import type { commonCauses } from "agent-cli-kernel";',
    'export const needed = (codes: string[]) => codes.includes("DOMAIN_DEADLINE_UNKNOWN" satisfies keyof typeof commonCauses);',
  ].join("\n"),
};

function writeConsumerLint(consumer: string): void {
  writeFileSync(join(consumer, "eslint.config.mjs"), consumerLintConfig);
  writeFileSync(join(consumer, "template.config.mjs"), templateLintConfig);
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        lib: ["ESNext"],
        module: "Preserve",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    })}\n`,
  );
  for (const [path, source] of Object.entries(applicationFiles)) {
    mkdirSync(dirname(join(consumer, path)), { recursive: true });
    writeFileSync(join(consumer, path), `${source}\n`);
  }
}

beforeAll(async () => {
  world.base = testFolder("pinned-commit-");
  world.kernel = join(world.base, "kernel");
  world.consumer = join(world.base, "consumer");
  world.commit = workingTreeCommit(repository, world.kernel);
  mkdirSync(join(world.consumer, "src"), { recursive: true });
  const dev = [
    "@eslint/js",
    "@types/bun",
    "typescript-eslint",
    "eslint",
    "typescript",
  ];
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
  writeFileSync(
    join(world.consumer, "src/rooted-file-check.ts"),
    rootedFileCheck,
  );
  writeFileSync(
    join(world.consumer, "src/rooted-file-types.ts"),
    rootedFileTypes,
  );
  writeFileSync(join(world.consumer, "src/xdg-base-check.ts"), xdgBaseCheck);
  writeFileSync(
    join(world.consumer, "tsconfig.rooted-file.json"),
    `${JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { types: ["bun"] },
      include: ["src/rooted-file-types.ts"],
    })}\n`,
  );
  writeConsumerLint(world.consumer);
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

test("the kernel repository's manifest names agent-cli-kernel, is a module with no version or prepare, and exports the kernel, five add-ons, rooted-file, xdg-base, lint, lint rules, the declaration and itself", () => {
  expect(manifest.name).toBe("agent-cli-kernel");
  expect(manifest.type).toBe("module");
  expect(Object.hasOwn(manifest, "version")).toBe(false);
  expect(Object.hasOwn(record(manifest.scripts), "prepare")).toBe(false);
  expect(exportNames).toEqual([
    ".",
    "./addons/approval",
    "./addons/diagnostics",
    "./addons/menu",
    "./addons/programs",
    "./addons/state",
    "./rooted-file",
    "./xdg-base",
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
  "a repository that installs the kernel imports readRootedFile from agent-cli-kernel/rooted-file, reads a plain file, refuses link, escape and size violations, and sees no seam parameter",
  async () => {
    const base = join(world.base, "rooted-file-consumer");
    const ran = await run(
      [process.execPath, "src/rooted-file-check.ts", base],
      world.consumer,
    );
    expect(ran.stderr).toBe("");
    expect(ran.exit).toBe(0);
    const observed = record(JSON.parse(ran.stdout));
    const realRoot = text(observed.realRoot);
    expect(observed).toEqual({
      arity: 3,
      seamCalled: false,
      realRoot,
      plain: { kind: "read", text: "hello", size: 5 },
      linked: {
        kind: "refused",
        path: "link.txt",
        reason: "symbolic-link",
        message: `link.txt is a symbolic link. Repair: replace the link with a regular file inside ${realRoot}.`,
      },
      linkedFolder: {
        kind: "refused",
        path: "linked-dir/secret.txt",
        reason: "linked-folder",
        message: `linked-dir/secret.txt crosses linked folder ${join(realRoot, "linked-dir")}. Repair: replace the symbolic link with a real folder inside ${realRoot}.`,
      },
      outsideRoot: {
        kind: "refused",
        path: "../outside/secret.txt",
        reason: "outside-root",
        message: `../outside/secret.txt is outside root ${realRoot}. Repair: pass a path inside ${realRoot}.`,
      },
      hardLink: {
        kind: "refused",
        path: "hard-link.txt",
        reason: "hard-link",
        message:
          "hard-link.txt is a hard link (link count 2). Repair: replace it with a copy, or remove the other link.",
      },
      overLimit: {
        kind: "refused",
        path: "big.txt",
        reason: "over-limit",
        message:
          "big.txt is 1025 bytes, above the 1024 byte limit. Repair: reduce the file size to at most 1024 bytes.",
      },
    });
    const checked = await run(
      [
        process.execPath,
        "node_modules/typescript/lib/tsc.js",
        "--noEmit",
        "-p",
        "tsconfig.rooted-file.json",
      ],
      world.consumer,
      buildBound,
    );
    expect({
      exit: checked.exit,
      output: checked.stdout + checked.stderr,
    }).toEqual({
      exit: 0,
      output: "",
    });
  },
  runBound + buildBound + 30_000,
);

test(
  "a repository that installs the kernel imports xdgBaseFolder from agent-cli-kernel/xdg-base and resolves base folders",
  async () => {
    const ran = await run(
      [process.execPath, "src/xdg-base-check.ts"],
      world.consumer,
    );
    expect(ran.stderr).toBe("");
    expect(ran.exit).toBe(0);
    expect(record(JSON.parse(ran.stdout))).toEqual({
      configured: "/var/opt/app/state",
      fallback: "/home/alice/.config",
      ignoredRelative: "/home/alice/.cache",
      runtimeUnset: null,
      fallbackDisabled: null,
    });
  },
  testBound,
);

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

const runIdentity = /"runId":"[0-9a-f-]{36}"/;

async function bothSettled<A, B>(
  first: Promise<A>,
  second: Promise<B>,
): Promise<[A, B]> {
  const [one, two] = await Promise.allSettled([first, second]);
  if (one.status === "rejected") throw one.reason;
  if (two.status === "rejected") throw two.reason;
  return [one.value, two.value];
}

async function sourceAndBinary(name: string) {
  const argv = ["match", "--name", name, "--json"];
  const [source, binary] = await bothSettled(
    run([process.execPath, "src/cli.ts", ...argv], world.consumer),
    run([join(world.consumer, "dist/bare"), ...argv], world.consumer),
  );
  const answer = ({ exit, stdout, stderr }: Ran) => {
    if (!runIdentity.test(stdout))
      throw new Error(`Expected one run identity in ${stdout}`);
    return {
      exit,
      stdout: stdout.replace(runIdentity, '"runId":"<run>"'),
      stderr,
    };
  };
  return { source: answer(source), binary: answer(binary) };
}

test(
  "the binary checks a pattern-checked option as the source run does: it accepts a matching name and refuses a mismatching one as a pattern mismatch",
  async () => {
    expect(world.binary?.exit).toBe(0);
    const [matching, mismatching] = await bothSettled(
      sourceAndBinary("abc"),
      sourceAndBinary("ABC"),
    );
    expect(matching.binary).toEqual(matching.source);
    expect(matching.binary.exit).toBe(0);
    expect(matching.binary.stdout).toContain("SUCCESS_UNCHANGED");
    expect(mismatching.binary).toEqual(mismatching.source);
    expect(mismatching.binary.exit).not.toBe(0);
    expect(mismatching.binary.stdout).toContain("USAGE_INVALID_INVOCATION");
    expect(mismatching.binary.stdout).toContain(
      "The option --name must match the pattern [a-z]+.",
    );
  },
  testBound,
);

const consumerLints = new Map<string, Promise<Ran>>();
const untypedGlobal = (ruleId: string) =>
  ruleId.startsWith("@typescript-eslint/no-unsafe-");

async function consumerFindings(config = "eslint.config.mjs") {
  const started =
    consumerLints.get(config) ??
    run(
      [
        process.execPath,
        "node_modules/eslint/bin/eslint.js",
        "--config",
        config,
        "--format",
        "json",
        ...["src/kernel", "src/addons", "src/app"],
      ],
      world.consumer,
      lintBound,
    );
  consumerLints.set(config, started);
  const ran = await started;
  if (ran.exit !== 0 && ran.exit !== 1)
    throw new Error(`ESLint exited ${ran.exit}:\n${ran.stderr}`);
  const results: unknown = JSON.parse(ran.stdout);
  if (!Array.isArray(results)) throw new Error("Expected ESLint's results.");
  const linted = results.map((result) => {
    const fields = record(result);
    const file = relative(world.consumer, text(fields.filePath));
    const messages: unknown = fields.messages;
    if (!Array.isArray(messages)) throw new Error("Expected messages.");
    return {
      file,
      messages: messages.map((each) => {
        const message = record(each);
        return {
          file,
          ruleId: text(message.ruleId),
          message: text(message.message),
        };
      }),
    };
  });
  return {
    files: linted.map(({ file }) => file).toSorted(),
    findings: linted
      .flatMap(({ messages }) => messages)
      .sort((a, b) =>
        `${a.file} ${a.ruleId}` < `${b.file} ${b.ruleId}` ? -1 : 1,
      ),
  };
}

const kernelPathFindings = [
  {
    file: "src/addons/diagnostics/log.ts",
    ruleId: "no-restricted-imports",
  },
  {
    file: "src/addons/programs/run.ts",
    ruleId: "no-restricted-properties",
  },
  {
    file: "src/addons/state/linux-flock.ts",
    ruleId: "no-restricted-imports",
  },
  {
    file: "src/kernel/causes.ts",
    ruleId: "repository/cause-literal-owner",
  },
  { file: "src/kernel/in.ts", ruleId: "repository/no-in-operator" },
  { file: "src/kernel/index.ts", ruleId: "no-restricted-syntax" },
  { file: "src/kernel/index.ts", ruleId: "repository/no-process-reach" },
  {
    file: "src/kernel/process-host.ts",
    ruleId: "repository/no-domain-output",
  },
  { file: "src/kernel/runtime.ts", ruleId: "no-restricted-imports" },
  { file: "src/kernel/runtime.ts", ruleId: "no-restricted-syntax" },
  { file: "src/kernel/runtime.ts", ruleId: "repository/no-process-reach" },
  {
    file: "src/kernel/validation/brand.ts",
    ruleId: "no-restricted-syntax",
  },
];

async function kernelPathHits(config?: string) {
  return (await consumerFindings(config)).findings
    .filter(
      ({ file, ruleId }) =>
        !file.startsWith("src/app/") && !untypedGlobal(ruleId),
    )
    .map(({ file, ruleId }) => ({ file, ruleId }));
}

test(
  "a repository that installs the kernel lints its src/kernel and src/addons files as its own source: no kernel path keeps an allowance",
  async () => {
    expect(await kernelPathHits()).toEqual(kernelPathFindings);
  },
  lintTestBound,
);

test(
  "the template's kernelLint call, with no add-on and the kernel's rules spread into its plugin, refuses the same kernel paths",
  async () => {
    expect(await kernelPathHits("template.config.mjs")).toEqual(
      kernelPathFindings,
    );
  },
  lintTestBound,
);

test(
  "the installed cause-literal-owner learns the codes from the installed kernel: it refuses a free known code and admits one checked against commonCauses",
  async () => {
    const { files, findings } = await consumerFindings();
    expect(files.filter((file) => file.startsWith("src/app/"))).toEqual([
      "src/app/cause.ts",
      "src/app/typed.ts",
    ]);
    const found = findings.filter(({ file }) => file.startsWith("src/app/"));
    expect(found.map(({ file, ruleId }) => ({ file, ruleId }))).toEqual([
      { file: "src/app/cause.ts", ruleId: "repository/cause-literal-owner" },
    ]);
    expect(found[0]?.message).toContain(
      'Import the owner once: import type { commonCauses } from "agent-cli-kernel";',
    );
  },
  lintTestBound,
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
