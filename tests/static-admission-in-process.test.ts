import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  Document as Fields,
  Environment,
  Options,
  Profile,
  Receipt,
} from "../src/static-admission.ts";
import {
  checkLock,
  checkPolicy,
  compare,
  compilerScope,
  discoveryScope,
  execute,
  fallowPass,
  inventory,
  jsonFile,
  nativeEnvironment,
  normalizedPaths,
  parseOptions,
  parseReceipt,
  run,
  semanticState,
  sourcePaths,
  successful,
  wholeReportScope,
} from "../src/static-admission.ts";
import { testFolder } from "./support/test-folder.ts";

type Tree = Record<string, string>;

const repository = resolve(import.meta.dir, "..");
const packet = join(repository, "profiles/static-admission");
const policyFiles = [
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "biome.json",
  ".fallowrc.json",
  ".gitignore",
  "bunfig.toml",
  "eslint.config.mjs",
  "eslint-rules.mjs",
  "bun.lock",
];
const usage =
  "Usage: bun run admit:static <repository> <simple|complex> <evidence folder>";
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const root = testFolder("static-admission-process-");
  folders.push(root);
  return root;
}

function fields(value: unknown): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("The test expected a document.");
  return Object.fromEntries(Object.entries(value));
}

function grow(root: string, tree: Tree): void {
  for (const [name, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

function environment(): Environment {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("FALLOW_")),
  );
}

function optionsFor(project: string, profile: Profile = "simple"): Options {
  return parseOptions(
    [project, profile, join(project, "evidence")],
    environment(),
  );
}

function evidenceOptions(project: string): Options {
  const options = optionsFor(project);
  mkdirSync(options.evidence, { recursive: true });
  return options;
}

async function causeOf(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error && "causeCode" in error
      ? error.causeCode
      : error;
  }
  return "accepted";
}

function policyProject(profile: Profile = "simple"): string {
  const root = folder();
  for (const file of policyFiles)
    copyFileSync(join(packet, profile, file), join(root, file));
  return root;
}

function editJson(root: string, file: string, change: (doc: Fields) => void) {
  const doc = fields(Bun.JSONC.parse(readFileSync(join(root, file), "utf8")));
  change(doc);
  writeFileSync(join(root, file), JSON.stringify(doc));
}

function fakeTool(project: string, name: string, executable: string): void {
  const path = join(project, "node_modules/.bin", name);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  symlinkSync(executable, path);
}

function stubTool(project: string, name: string, body: string): void {
  const path = join(project, "node_modules/.bin", name);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function linkTool(project: string, name: string): void {
  const path = join(project, "node_modules/.bin", name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(join(repository, "node_modules/.bin", name), path);
}

function toolProject(extra: Tree = {}): string {
  const root = folder();
  for (const file of policyFiles.filter((name) => name !== "bun.lock"))
    copyFileSync(join(packet, "simple", file), join(root, file));
  grow(root, {
    "src/cli.ts": "export const answer = 1;\n",
    "tests/cli.test.ts":
      'import { answer } from "../src/cli.ts";\nconsole.log(answer);\n',
    ...extra,
  });
  linkTool(root, "tsc");
  linkTool(root, "fallow");
  return root;
}

function receipt(stdout: string): Receipt {
  return {
    name: "probe",
    argv: ["probe"],
    cwd: "/",
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

function semanticReport(semantic: Fields = {}, identity: Fields = {}): Fields {
  return {
    _meta: {
      type_aware: {
        required_completeness: "complete",
        executed: true,
        candidate_count: 1,
        selected_tsconfigs: ["tsconfig.json"],
        queries: [{ status: "complete" }],
        identity: {
          completeness: "complete",
          project_config_hash: "abc123",
          ...identity,
        },
        ...semantic,
      },
    },
  };
}

function deferredReport(semantic: Fields = {}, identity: Fields = {}): Fields {
  return semanticReport(
    {
      executed: false,
      candidate_count: 0,
      selected_tsconfigs: undefined,
      queries: undefined,
      ...semantic,
    },
    { project_config_hash: "deferred:no-semantic-queries", ...identity },
  );
}

function goodLock(): Fields {
  return {
    lockfileVersion: 3,
    workspaces: {
      "": { devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" } },
    },
    overrides: { "@scope/old@npm:ts@^6": { ".": "npm:ts@6.0.2" } },
    packages: {
      eslint: ["eslint@10.15.0"],
      native: ["ts@7.0.2"],
      "@scope/old": ["ts@6.0.2"],
    },
  };
}

function goodExpected(): Fields {
  return {
    devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
    overrides: { "@scope/old@npm:ts@^6": "npm:ts@6.0.2" },
  };
}

async function lockCause(
  lock: unknown,
  expected: Fields = goodExpected(),
): Promise<unknown> {
  const root = folder();
  writeFileSync(join(root, "bun.lock"), JSON.stringify(lock));
  return await causeOf(() => checkLock(root, expected));
}

function lockWith(change: (lock: Fields) => void): Fields {
  const lock = goodLock();
  change(lock);
  return lock;
}

test("parseOptions resolves the three paths and keeps the environment it was given", () => {
  const env = { MARKER: "kept" };
  const options = parseOptions(["repo", "complex", "out/evidence"], env);
  expect(options).toEqual({
    project: resolve("repo"),
    profile: "complex",
    evidence: resolve("out/evidence"),
    env,
  });
  expect(options.env).toBe(env);
  expect(parseOptions(["repo", "simple", "e"], env).profile).toBe("simple");
});

test("parseOptions refuses a missing project, profile or evidence folder with the usage line", async () => {
  for (const argv of [
    [],
    ["repo"],
    ["repo", "simple"],
    ["", "simple", "evidence"],
    ["repo", "simple", ""],
  ]) {
    expect(await causeOf(() => parseOptions(argv, {}))).toBe("usage");
  }
  expect(() => parseOptions(["repo"], {})).toThrow(usage);
});

test("parseOptions refuses an extra argument and an unknown profile", async () => {
  expect(await causeOf(() => parseOptions(["r", "simple", "e", "x"], {}))).toBe(
    "usage",
  );
  expect(await causeOf(() => parseOptions(["r", "medium", "e"], {}))).toBe(
    "usage:profile",
  );
  expect(await causeOf(() => parseOptions(["r", "", "e"], {}))).toBe(
    "usage:profile",
  );
  expect(() => parseOptions(["r", "medium", "e"], {})).toThrow(usage);
});

test("compare accepts equal scalars, arrays and nested documents", () => {
  expect(() => compare(1, 1, "p")).not.toThrow();
  expect(() => compare("a", "a", "p")).not.toThrow();
  expect(() => compare(null, null, "p")).not.toThrow();
  expect(() => compare([1, { a: 2 }], [1, { a: 2 }], "p")).not.toThrow();
  expect(() =>
    compare({ a: { b: [1] }, c: true }, { c: true, a: { b: [1] } }, "p"),
  ).not.toThrow();
});

test("compare names the path of a scalar, array or null difference", async () => {
  expect(await causeOf(() => compare(1, 2, "p"))).toBe("p");
  expect(await causeOf(() => compare("1", 1, "p"))).toBe("p");
  expect(await causeOf(() => compare([1, 2], [2, 1], "p"))).toBe("p");
  expect(await causeOf(() => compare([], {}, "p"))).toBe("p");
  expect(await causeOf(() => compare({}, null, "p"))).toBe("p");
  expect(await causeOf(() => compare(undefined, {}, "p"))).toBe("p");
});

test("compare refuses a document where the other side has a list", async () => {
  expect(await causeOf(() => compare([], { a: 1 }, "p"))).toBe("p");
  expect(await causeOf(() => compare({ a: 1 }, [], "p"))).toBe("p");
});

test("compare names the nested path of a missing, extra or changed key", async () => {
  expect(await causeOf(() => compare({}, { a: { b: 1 } }, "p"))).toBe("p.a");
  expect(await causeOf(() => compare({ a: {} }, { a: { b: 1 } }, "p"))).toBe(
    "p.a.b",
  );
  expect(await causeOf(() => compare({ a: { b: 1 } }, { a: {} }, "p"))).toBe(
    "p.a.b",
  );
  expect(
    await causeOf(() => compare({ a: { b: 2 } }, { a: { b: 1 } }, "p")),
  ).toBe("p.a.b");
});

test("compare reports the first difference in sorted key order", async () => {
  expect(
    await causeOf(() => compare({ a: 1, b: 2 }, { b: 1, a: 2 }, "p")),
  ).toBe("p.a");
  expect(
    await causeOf(() => compare({ z: 1, y: 1 }, { a: 1, z: 1, y: 1 }, "p")),
  ).toBe("p.a");
  expect(await causeOf(() => compare({ b: 1, a: 1 }, {}, "p"))).toBe("p.a");
});

test("jsonFile reads comments and trailing commas as a document", async () => {
  const root = folder();
  grow(root, { "a.json": '// note\n{ "a": [1, 2,], }\n' });
  expect(await jsonFile(join(root, "a.json"))).toEqual({ a: [1, 2] });
});

test("jsonFile refuses a missing file by name and a non-document by path", async () => {
  const root = folder();
  grow(root, { "list.json": "[]", "number.json": "5", "null.json": "null" });
  expect(await causeOf(() => jsonFile(join(root, "gone.json")))).toBe(
    "file:missing:gone.json",
  );
  for (const name of ["list.json", "number.json", "null.json"])
    expect(await causeOf(() => jsonFile(join(root, name)))).toBe(
      `json:${join(root, name)}`,
    );
});

test("jsonFile passes on a read error that is not a missing file", async () => {
  const root = folder();
  mkdirSync(join(root, "directory.json"));
  const cause = await causeOf(() => jsonFile(join(root, "directory.json")));
  expect(cause).toBeInstanceOf(Error);
  expect(cause).toHaveProperty("code", "EISDIR");
});

test("jsonFile passes on a parse error", async () => {
  const root = folder();
  grow(root, { "broken.json": "{ not json" });
  expect(
    await causeOf(() => jsonFile(join(root, "broken.json"))),
  ).toBeInstanceOf(SyntaxError);
});

test("inventory digests every file in sorted order and skips tool folders", async () => {
  const root = folder();
  grow(root, {
    "b.txt": "hello",
    "a/z.txt": "z",
    "a.txt": "a",
    "deep/er/file.txt": "x",
    ".git/config": "ignored",
    "node_modules/pkg/index.js": "ignored",
    ".fallow/cache": "ignored",
    "deep/.fallow/cache": "ignored",
    "deep/node_modules/pkg": "ignored",
  });
  mkdirSync(join(root, "empty"));
  const files = await inventory(root);
  expect(Object.keys(files)).toEqual([
    "a.txt",
    "a/z.txt",
    "b.txt",
    "deep/er/file.txt",
  ]);
  expect(files["b.txt"]).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

test("inventory lists nested files in one sorted order", async () => {
  const root = folder();
  const names = Array.from(
    { length: 12 },
    (_, index) => `d${index % 4}/f${index}.txt`,
  ).sort();
  grow(
    root,
    Object.fromEntries([...names].reverse().map((name) => [name, name])),
  );
  expect(Object.keys(await inventory(root))).toEqual(names);
});

test("inventory sees a content change and an added file", async () => {
  const root = folder();
  grow(root, { "a.txt": "one" });
  const before = await inventory(root);
  writeFileSync(join(root, "a.txt"), "two");
  grow(root, { "b.txt": "x" });
  const after = await inventory(root);
  expect(after["a.txt"]).not.toBe(before["a.txt"]);
  expect(Object.keys(after)).toEqual(["a.txt", "b.txt"]);
});

test("inventory refuses a symbolic link and names its relative path", async () => {
  const root = folder();
  grow(root, { "a/real.txt": "x" });
  symlinkSync(join(root, "a/real.txt"), join(root, "a/link.txt"));
  expect(await causeOf(() => inventory(root))).toBe("scope:symlink:a/link.txt");
});

test("inventory ignores a symbolic link inside a skipped folder", async () => {
  const root = folder();
  grow(root, { "a.txt": "x", "node_modules/real": "y" });
  symlinkSync(join(root, "a.txt"), join(root, "node_modules/link"));
  expect(Object.keys(await inventory(root))).toEqual(["a.txt"]);
});

test("nativeEnvironment refuses each fallow variable that changes the pinned run", async () => {
  for (const name of [
    "FALLOW_PRODUCTION",
    "FALLOW_PRODUCTION_DEAD_CODE",
    "FALLOW_CHANGED_SINCE",
    "FALLOW_DIFF_FILE",
    "FALLOW_ROOT",
    "FALLOW_EXTRA_ARGS",
    "FALLOW_MAX_FILE_SIZE",
  ])
    expect(await causeOf(() => nativeEnvironment({ [name]: "1" }))).toBe(
      `environment:${name}`,
    );
});

test("nativeEnvironment forces plain output, keeps the rest and leaves its input alone", () => {
  const input = {
    FALLOW_PRODUCTION: "",
    FORCE_COLOR: "3",
    NO_COLOR: undefined,
    KEPT: "yes",
  };
  expect(nativeEnvironment(input)).toEqual({
    FALLOW_PRODUCTION: "",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    KEPT: "yes",
  });
  expect(input.FORCE_COLOR).toBe("3");
});

test("execute records the command, its folder, exit code and both streams", async () => {
  const project = folder();
  const options = evidenceOptions(project);
  const argv = ["/bin/sh", "-c", "printf out; printf err >&2; exit 3"];
  const result = await execute(options, "probe", argv);
  expect(result).toEqual({
    name: "probe",
    argv,
    cwd: project,
    exitCode: 3,
    stdout: "out",
    stderr: "err",
  });
  expect(readFileSync(join(options.evidence, "probe.json"), "utf8")).toBe(
    JSON.stringify(result, null, 2) + "\n",
  );
});

test("execute runs in the project folder with plain colour settings and the given environment", async () => {
  const project = folder();
  const options = evidenceOptions(project);
  const result = await execute(options, "env", [
    "/bin/sh",
    "-c",
    'pwd; printf "%s%s%s" "$NO_COLOR" "$FORCE_COLOR" "$MARKER"',
  ]);
  expect(result.stdout).toBe(`${project}\n10`);
  const marked = parseOptions([project, "simple", options.evidence], {
    MARKER: "m",
  });
  const second = await execute(marked, "marker", [
    "/bin/sh",
    "-c",
    'printf "%s" "$MARKER"',
  ]);
  expect(second.stdout).toBe("m");
});

test("execute gives the command no standard input", async () => {
  const project = folder();
  const options = evidenceOptions(project);
  const result = await execute(options, "stdin", [
    "/bin/sh",
    "-c",
    "cat; printf done",
  ]);
  expect(result.stdout).toBe("done");
});

test("execute refuses a forbidden fallow variable before it starts the command", async () => {
  const project = folder();
  const options = parseOptions([project, "simple", join(project, "e")], {
    FALLOW_ROOT: "/",
  });
  expect(await causeOf(() => execute(options, "probe", ["/bin/true"]))).toBe(
    "environment:FALLOW_ROOT",
  );
  expect(existsSync(join(project, "e"))).toBe(false);
});

test("parseReceipt returns the document a command printed", () => {
  expect(parseReceipt(receipt('{"a":1}'))).toEqual({ a: 1 });
});

test("parseReceipt names the command when its output is not JSON or not a document", async () => {
  expect(await causeOf(() => parseReceipt(receipt("plain text")))).toBe(
    "probe:non-json",
  );
  expect(await causeOf(() => parseReceipt(receipt("")))).toBe("probe:non-json");
  for (const stdout of ["[]", "5", "null", '"text"'])
    expect(await causeOf(() => parseReceipt(receipt(stdout)))).toBe(
      "probe:non-object",
    );
});

test("successful returns the receipt of a command that exits zero", async () => {
  const options = evidenceOptions(folder());
  const result = await successful(options, "good", [
    "/bin/sh",
    "-c",
    "printf fine",
  ]);
  expect(result).toMatchObject({ name: "good", exitCode: 0, stdout: "fine" });
});

test("successful refuses a failing command and still records its receipt", async () => {
  const options = evidenceOptions(folder());
  expect(
    await causeOf(() =>
      successful(options, "bad", ["/bin/sh", "-c", "printf why >&2; exit 2"]),
    ),
  ).toBe("bad:exit");
  expect(
    fields(
      JSON.parse(readFileSync(join(options.evidence, "bad.json"), "utf8")),
    ),
  ).toMatchObject({ exitCode: 2, stderr: "why" });
});

test("sourcePaths returns the typescript files in sorted order", () => {
  expect(
    sourcePaths({
      "tests/b.test.ts": "x",
      "package.json": "x",
      "src/z.ts": "x",
      "src/a/nested.ts": "x",
      "src/a.d.ts": "x",
      "src/view.tsx": "x",
    }),
  ).toEqual(["src/a.d.ts", "src/a/nested.ts", "src/z.ts", "tests/b.test.ts"]);
});

test("sourcePaths refuses a project with no typescript file", async () => {
  expect(await causeOf(() => sourcePaths({}))).toBe("scope:empty");
  expect(
    await causeOf(() => sourcePaths({ "package.json": "x", "src/a.js": "x" })),
  ).toBe("scope:empty");
});

test("sourcePaths refuses a typescript file outside src and tests by path", async () => {
  for (const path of [
    "scripts/run.ts",
    "run.ts",
    "srcx/a.ts",
    "a/src/b.ts",
    "src/.ts",
    "tests.ts",
  ])
    expect(
      await causeOf(() => sourcePaths({ "src/ok.ts": "x", [path]: "x" })),
    ).toBe(`scope:outside-includes:${path}`);
});

test("normalizedPaths makes each path relative to the root and sorts them", () => {
  expect(
    normalizedPaths("/work/root", [
      "./tests/c.test.ts",
      "src/b.ts",
      "/work/root/src/a.ts",
      "../other/d.ts",
    ]),
  ).toEqual(["../other/d.ts", "src/a.ts", "src/b.ts", "tests/c.test.ts"]);
});

test("normalizedPaths refuses a missing list and a non-text entry", async () => {
  for (const value of [undefined, null, "src/a.ts", { 0: "src/a.ts" }])
    expect(await causeOf(() => normalizedPaths("/r", value))).toBe(
      "scope:path-list-missing",
    );
  for (const entry of [1, null, {}, ["a"]])
    expect(await causeOf(() => normalizedPaths("/r", ["a.ts", entry]))).toBe(
      "scope:path-missing",
    );
});

test("compilerScope accepts the files the real compiler lists", async () => {
  const project = toolProject();
  const options = evidenceOptions(project);
  await compilerScope(options, ["src/cli.ts", "tests/cli.test.ts"]);
  expect(
    fields(
      JSON.parse(
        readFileSync(join(options.evidence, "compiler-config.json"), "utf8"),
      ),
    ),
  ).toMatchObject({
    argv: ["node_modules/.bin/tsc", "--showConfig", "-p", "tsconfig.json"],
    exitCode: 0,
  });
});

test("compilerScope refuses a file list that differs from the compiler's", async () => {
  const project = toolProject();
  const options = evidenceOptions(project);
  expect(await causeOf(() => compilerScope(options, ["src/cli.ts"]))).toBe(
    "scope:compiler-files",
  );
  expect(
    await causeOf(() =>
      compilerScope(options, ["src/cli.ts", "tests/cli.test.ts", "src/x.ts"]),
    ),
  ).toBe("scope:compiler-files");
});

test("compilerScope refuses a failing compiler and an output that is not a document", async () => {
  const broken = toolProject();
  rmSync(join(broken, "tsconfig.json"));
  expect(
    await causeOf(() => compilerScope(evidenceOptions(broken), ["src/cli.ts"])),
  ).toBe("compiler-config:exit");
  const echoing = toolProject();
  stubTool(echoing, "tsc", "printf 'not a document'");
  expect(
    await causeOf(() =>
      compilerScope(evidenceOptions(echoing), ["src/cli.ts"]),
    ),
  ).toBe("compiler-config:non-json");
});

test("discoveryScope returns the front door, the tests and the lint rules entry", async () => {
  const project = toolProject();
  const options = evidenceOptions(project);
  expect(
    await discoveryScope(options, ["src/cli.ts", "tests/cli.test.ts"]),
  ).toEqual(["src/cli.ts", "tests/cli.test.ts", "eslint-rules.mjs"]);
  expect(
    fields(
      JSON.parse(
        readFileSync(join(options.evidence, "whole-discovery.json"), "utf8"),
      ),
    ),
  ).toMatchObject({
    argv: [
      "node_modules/.bin/fallow",
      "list",
      "--files",
      "--entry-points",
      "--format",
      "json",
      "--quiet",
    ],
    exitCode: 0,
  });
});

test("discoveryScope leaves a source file that no entry needs out of the entries it requires", async () => {
  const project = toolProject({
    "src/cli.ts":
      'import { helper } from "./helper.ts";\nexport const answer = helper;\n',
    "src/helper.ts": "export const helper = 1;\n",
  });
  const options = evidenceOptions(project);
  expect(
    await discoveryScope(options, [
      "src/cli.ts",
      "src/helper.ts",
      "tests/cli.test.ts",
    ]),
  ).toEqual(["src/cli.ts", "tests/cli.test.ts", "eslint-rules.mjs"]);
});

test("discoveryScope refuses a file list that differs from fallow's", async () => {
  const options = evidenceOptions(toolProject());
  expect(await causeOf(() => discoveryScope(options, ["src/cli.ts"]))).toBe(
    "scope:fallow-files",
  );
  expect(
    await causeOf(() =>
      discoveryScope(options, ["src/cli.ts", "tests/cli.test.ts", "src/x.ts"]),
    ),
  ).toBe("scope:fallow-files");
});

test("discoveryScope refuses a project without a front door", async () => {
  const project = toolProject({ "src/cli.ts": "" });
  rmSync(join(project, "src/cli.ts"));
  grow(project, { "src/main.ts": "export const a = 1;\n" });
  const options = evidenceOptions(project);
  expect(
    await causeOf(() =>
      discoveryScope(options, ["src/main.ts", "tests/cli.test.ts"]),
    ),
  ).toBe("scope:front-door-missing");
});

test("discoveryScope refuses a project without a test file", async () => {
  const project = toolProject();
  rmSync(join(project, "tests"), { recursive: true });
  const options = evidenceOptions(project);
  expect(await causeOf(() => discoveryScope(options, ["src/cli.ts"]))).toBe(
    "scope:tests-missing",
  );
});

test("discoveryScope refuses a project whose lint rules file is no entry", async () => {
  const project = toolProject();
  editJson(project, ".fallowrc.json", (doc) => {
    doc.entry = ["tests/cli.test.ts"];
  });
  const options = evidenceOptions(project);
  expect(
    await causeOf(() =>
      discoveryScope(options, ["src/cli.ts", "tests/cli.test.ts"]),
    ),
  ).toBe("scope:eslint-rule-entry-missing");
});

function listingProject(script: string): string {
  const project = toolProject();
  fakeTool(project, "fallow", "/bin/sh");
  grow(project, { list: script });
  return project;
}

test("discoveryScope refuses a failing or unreadable listing", async () => {
  const failing = listingProject("exit 4");
  expect(
    await causeOf(() =>
      discoveryScope(evidenceOptions(failing), ["src/cli.ts"]),
    ),
  ).toBe("whole-discovery:exit");
  const plain = listingProject("printf plain");
  expect(
    await causeOf(() => discoveryScope(evidenceOptions(plain), ["src/cli.ts"])),
  ).toBe("whole-discovery:non-json");
});

test("discoveryScope refuses a listing without entry points or with a malformed entry", async () => {
  const listing = (entries: string) =>
    `{"files":["eslint-rules.mjs","eslint.config.mjs","src/cli.ts","tests/a.test.ts"]${entries}}`;
  const paths = ["src/cli.ts", "tests/a.test.ts"];
  const cases: [string, string][] = [
    [listing(""), "scope:entry-points-missing"],
    [listing(',"entry_points":{}'), "scope:entry-points-missing"],
    [listing(',"entry_points":[5]'), "scope:entry"],
    [listing(',"entry_points":[{}]'), "scope:path-missing"],
    [
      listing(',"entry_points":[{"path":"src/cli.ts"}]'),
      "scope:entry-missing:tests/a.test.ts",
    ],
  ];
  for (const [output, expected] of cases) {
    const project = listingProject(`cat <<'JSON'\n${output}\nJSON`);
    expect(
      await causeOf(() => discoveryScope(evidenceOptions(project), paths)),
    ).toBe(expected);
  }
});

test("wholeReportScope accepts a report whose manual entries match and has no diagnostics", () => {
  const entries = ["src/cli.ts", "tests/a.test.ts", "eslint-rules.mjs"];
  const report = (extra: Fields = {}) => ({
    report: {
      entry_points: { sources: { manual_entry: 2 } },
      ...extra,
    },
  });
  expect(() => wholeReportScope(report(), entries)).not.toThrow();
  expect(() =>
    wholeReportScope(report({ workspace_diagnostics: [] }), entries),
  ).not.toThrow();
});

test("wholeReportScope names the part of the report that is missing or wrong", async () => {
  const entries = ["a", "b", "c"];
  const sources = (manual: unknown) => ({
    report: { entry_points: { sources: { manual_entry: manual } } },
  });
  expect(await causeOf(() => wholeReportScope({}, entries))).toBe(
    "scope:whole-report",
  );
  expect(await causeOf(() => wholeReportScope({ report: {} }, entries))).toBe(
    "scope:whole-entries",
  );
  expect(
    await causeOf(() =>
      wholeReportScope({ report: { entry_points: {} } }, entries),
    ),
  ).toBe("scope:whole-entry-sources");
  expect(await causeOf(() => wholeReportScope(sources(3), entries))).toBe(
    "scope:whole-manual-entries",
  );
  expect(await causeOf(() => wholeReportScope(sources(1), entries))).toBe(
    "scope:whole-manual-entries",
  );
  expect(
    await causeOf(() => wholeReportScope(sources(undefined), entries)),
  ).toBe("scope:whole-manual-entries");
  expect(() => wholeReportScope(sources(2), entries)).not.toThrow();
  expect(() => wholeReportScope(sources(0), ["only"])).not.toThrow();
  expect(
    await causeOf(() =>
      wholeReportScope(
        {
          report: {
            entry_points: { sources: { manual_entry: 2 } },
            workspace_diagnostics: [{ message: "x" }],
          },
        },
        entries,
      ),
    ),
  ).toBe("scope:whole-diagnostics");
});

test("semanticState reports a complete semantic run when every query finished", () => {
  expect(semanticState(semanticReport(), "pass")).toBe("complete");
  expect(
    semanticState(
      semanticReport({
        queries: [{ status: "complete" }, { status: "complete" }],
      }),
      "pass",
    ),
  ).toBe("complete");
});

test("semanticState reports an unnecessary semantic run when none was needed", () => {
  expect(semanticState(deferredReport(), "pass")).toBe("unnecessary");
  expect(semanticState(deferredReport({ queries: [] }), "pass")).toBe(
    "unnecessary",
  );
});

test("semanticState names the pass when the semantic evidence is absent", async () => {
  expect(await causeOf(() => semanticState({}, "whole"))).toBe(
    "whole:semantic-missing",
  );
  expect(await causeOf(() => semanticState({ _meta: {} }, "whole"))).toBe(
    "whole:semantic-missing",
  );
  expect(await causeOf(() => semanticState({ _meta: 5 }, "whole"))).toBe(
    "whole:semantic-missing",
  );
  expect(
    await causeOf(() =>
      semanticState(semanticReport({ identity: undefined }), "whole"),
    ),
  ).toBe("whole:semantic-identity-missing");
});

test("semanticState refuses a run that was not required or did not complete", async () => {
  expect(
    await causeOf(() =>
      semanticState(
        semanticReport({ required_completeness: "best-effort" }),
        "p",
      ),
    ),
  ).toBe("p:semantic-policy");
  expect(
    await causeOf(() =>
      semanticState(semanticReport({}, { completeness: "partial" }), "p"),
    ),
  ).toBe("p:semantic-incomplete");
  expect(
    await causeOf(() =>
      semanticState(
        semanticReport(
          { required_completeness: "best-effort" },
          { completeness: "partial" },
        ),
        "p",
      ),
    ),
  ).toBe("p:semantic-policy");
});

test("semanticState refuses an unnecessary run that carries evidence of a query", async () => {
  expect(
    await causeOf(() =>
      semanticState(deferredReport({}, { project_config_hash: "abc" }), "p"),
    ),
  ).toBe("p:unnecessary-evidence");
  expect(
    await causeOf(() =>
      semanticState(deferredReport({ candidate_count: 1 }), "p"),
    ),
  ).toBe("p:unnecessary-candidates");
  expect(
    await causeOf(() =>
      semanticState(deferredReport({ queries: [{ status: "complete" }] }), "p"),
    ),
  ).toBe("p:unnecessary-queries");
});

test("semanticState refuses an executed run without projects, queries or complete answers", async () => {
  expect(
    await causeOf(() =>
      semanticState(semanticReport({ executed: undefined }), "p"),
    ),
  ).toBe("p:execution-missing");
  expect(
    await causeOf(() =>
      semanticState(semanticReport({ executed: "true" }), "p"),
    ),
  ).toBe("p:execution-missing");
  for (const projects of [undefined, [], "tsconfig.json"])
    expect(
      await causeOf(() =>
        semanticState(semanticReport({ selected_tsconfigs: projects }), "p"),
      ),
    ).toBe("p:projects-missing");
  for (const queries of [undefined, [], {}])
    expect(
      await causeOf(() => semanticState(semanticReport({ queries }), "p")),
    ).toBe("p:queries-missing");
  expect(
    await causeOf(() =>
      semanticState(
        semanticReport({
          queries: [{ status: "complete" }, { status: "partial" }],
        }),
        "p",
      ),
    ),
  ).toBe("p:query-incomplete");
  expect(
    await causeOf(() => semanticState(semanticReport({ queries: [{}] }), "p")),
  ).toBe("p:query-incomplete");
  expect(
    await causeOf(() => semanticState(semanticReport({ queries: [5] }), "p")),
  ).toBe("p:query");
});

const pinnedFallow = fields(
  fields(JSON.parse(readFileSync(join(packet, "simple/package.json"), "utf8")))
    .devDependencies,
).fallow;

function fallowProject(report: Fields | string, exitCode = 0): string {
  const project = folder();
  grow(project, {
    "report.json": typeof report === "string" ? report : JSON.stringify(report),
    "pass.sh": `cat report.json\nexit ${exitCode}\n`,
  });
  return project;
}

function deadCode(extra: Fields = {}): Fields {
  return {
    kind: "dead-code",
    version: pinnedFallow,
    ...deferredReport(),
    ...extra,
  };
}

test("fallowPass returns the report with its exit code and semantic state", async () => {
  const project = fallowProject(deadCode());
  const options = evidenceOptions(project);
  const result = await fallowPass(options, "whole", "/bin/sh pass.sh");
  expect(result).toEqual({
    name: "whole",
    exitCode: 0,
    report: deadCode(),
    semantic: "unnecessary",
  });
  expect(existsSync(join(options.evidence, "whole.json"))).toBe(true);
});

test("fallowPass reports findings through the exit code instead of refusing", async () => {
  const project = fallowProject(deadCode({ unused_files: [{}] }), 1);
  const result = await fallowPass(
    evidenceOptions(project),
    "production",
    "/bin/sh pass.sh",
  );
  expect(result).toMatchObject({
    name: "production",
    exitCode: 1,
    semantic: "unnecessary",
  });
});

test("fallowPass reports a complete semantic run", async () => {
  const project = fallowProject({
    kind: "dead-code",
    version: pinnedFallow,
    ...semanticReport(),
  });
  const result = await fallowPass(
    evidenceOptions(project),
    "whole",
    "/bin/sh pass.sh",
  );
  expect(result.semantic).toBe("complete");
});

test("fallowPass refuses a command that is not text", async () => {
  const options = evidenceOptions(folder());
  for (const command of [undefined, 5, null, ["fallow"]])
    expect(await causeOf(() => fallowPass(options, "whole", command))).toBe(
      "whole:command",
    );
  expect(existsSync(join(options.evidence, "whole.json"))).toBe(false);
});

test("fallowPass refuses output that is not a JSON document", async () => {
  for (const output of ["plain", "[]"]) {
    const options = evidenceOptions(fallowProject(output));
    expect(
      await causeOf(() => fallowPass(options, "whole", "/bin/sh pass.sh")),
    ).toBe(output === "plain" ? "whole:non-json" : "whole:non-object");
  }
});

test("fallowPass names a native error and refuses an error report that exited zero", async () => {
  const native = fallowProject({ error: true, message: "boom" }, 2);
  expect(
    await causeOf(() =>
      fallowPass(evidenceOptions(native), "whole", "/bin/sh pass.sh"),
    ),
  ).toBe("whole:native-error");
  const silent = fallowProject({ error: true, message: "boom" }, 0);
  expect(
    await causeOf(() =>
      fallowPass(evidenceOptions(silent), "whole", "/bin/sh pass.sh"),
    ),
  ).toBe("whole:invalid-error-exit");
});

test("fallowPass refuses a report of another kind or another fallow version", async () => {
  for (const extra of [
    { kind: "health" },
    { version: "0.0.0" },
    { kind: undefined },
    { version: undefined },
  ]) {
    const options = evidenceOptions(fallowProject(deadCode(extra)));
    expect(
      await causeOf(() => fallowPass(options, "whole", "/bin/sh pass.sh")),
    ).toBe("whole:identity");
  }
});

test("fallowPass refuses a report whose semantic evidence fails, naming the pass", async () => {
  const project = fallowProject(
    deadCode(semanticReport({ required_completeness: "best-effort" })),
  );
  expect(
    await causeOf(() =>
      fallowPass(evidenceOptions(project), "production", "/bin/sh pass.sh"),
    ),
  ).toBe("production:semantic-policy");
});

test("checkPolicy accepts a project that carries each profile's policy files exactly", async () => {
  for (const profile of ["simple", "complex"] as const) {
    const root = policyProject(profile);
    const actual = await checkPolicy(optionsFor(root, profile));
    expect(actual).toEqual(
      fields(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))),
    );
  }
});

test("checkPolicy refuses a profile whose policy differs from the project's", async () => {
  const root = policyProject("simple");
  expect(
    await causeOf(() => checkPolicy(optionsFor(root, "complex"))),
  ).toStartWith("policy:");
});

test("checkPolicy refuses a changed package.json field by its name", async () => {
  const changes: [string, unknown][] = [
    ["packageManager", "bun@0.0.1"],
    ["private", false],
    ["type", "commonjs"],
    ["scripts", {}],
    ["dependencies", { extra: "1.0.0" }],
    ["devDependencies", {}],
    ["overrides", {}],
  ];
  for (const [key, value] of changes) {
    const root = policyProject("simple");
    editJson(root, "package.json", (doc) => {
      doc[key] = value;
    });
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toStartWith(
      `policy:package.json.${key}`,
    );
  }
});

test("checkPolicy ignores a package.json field outside the policy", async () => {
  const root = policyProject("simple");
  editJson(root, "package.json", (doc) => {
    doc.name = "another-name";
    doc.description = "another";
    doc.version = "9.9.9";
  });
  await checkPolicy(optionsFor(root));
});

test("checkPolicy names the path of an extra key in each JSON policy file", async () => {
  for (const file of [
    "tsconfig.base.json",
    "tsconfig.json",
    "biome.json",
    ".fallowrc.json",
  ]) {
    const root = policyProject("simple");
    editJson(root, file, (doc) => {
      doc.extra = 1;
    });
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
      `policy:${file}.extra`,
    );
  }
});

test("checkPolicy names each text policy file that changed", async () => {
  for (const file of [
    ".gitignore",
    "bunfig.toml",
    "eslint.config.mjs",
    "eslint-rules.mjs",
  ]) {
    const root = policyProject("simple");
    writeFileSync(
      join(root, file),
      `${readFileSync(join(root, file), "utf8")}\nextra\n`,
    );
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
      `policy:${file}`,
    );
  }
});

test("checkPolicy names a missing JSON policy file", async () => {
  for (const file of [
    "package.json",
    "tsconfig.base.json",
    "tsconfig.json",
    "biome.json",
    ".fallowrc.json",
    "bun.lock",
  ]) {
    const root = policyProject("simple");
    rmSync(join(root, file));
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
      `file:missing:${file}`,
    );
  }
});

test("checkPolicy passes on the read error of a missing text policy file", async () => {
  for (const file of [
    ".gitignore",
    "bunfig.toml",
    "eslint.config.mjs",
    "eslint-rules.mjs",
  ]) {
    const root = policyProject("simple");
    rmSync(join(root, file));
    const cause = await causeOf(() => checkPolicy(optionsFor(root)));
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toHaveProperty("code", "ENOENT");
  }
});

test("checkPolicy refuses a lock file of another version", async () => {
  const root = policyProject("simple");
  editJson(root, "bun.lock", (doc) => {
    doc.lockfileVersion = 2;
  });
  expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
    "policy:bun.lock.lockfileVersion",
  );
});

test("checkLock accepts a lock that pins each dependency and override the policy names", async () => {
  expect(await lockCause(goodLock())).toBe("accepted");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { ...fields(lock.packages), extra: ["extra@1.0.0"] };
      }),
    ),
  ).toBe("accepted");
});

test("checkLock refuses a lock of another version", async () => {
  for (const version of [2, 4, "3", undefined])
    expect(
      await lockCause(
        lockWith((lock) => {
          lock.lockfileVersion = version;
        }),
      ),
    ).toBe("policy:bun.lock.lockfileVersion");
});

test("checkLock refuses a lock without workspaces, a root workspace or packages", async () => {
  expect(
    await lockCause(
      lockWith((lock) => {
        delete lock.workspaces;
      }),
    ),
  ).toBe("policy:bun.lock.workspaces");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = { other: {} };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root");
  expect(
    await lockCause(
      lockWith((lock) => {
        delete lock.packages;
      }),
    ),
  ).toBe("policy:bun.lock.packages");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = [];
      }),
    ),
  ).toBe("policy:bun.lock.packages");
});

test("checkLock refuses an override the policy does not pin or the lock does not record", async () => {
  expect(await lockCause(goodLock(), {})).toBe("policy:package.json.overrides");
  expect(
    await lockCause(goodLock(), { ...goodExpected(), overrides: [] }),
  ).toBe("policy:package.json.overrides");
  expect(
    await lockCause(goodLock(), {
      ...goodExpected(),
      overrides: { "@scope/old@npm:ts@^6": 6 },
    }),
  ).toBe("policy:package.json.overrides");
  expect(
    await lockCause(
      lockWith((lock) => {
        delete lock.overrides;
      }),
    ),
  ).toBe("policy:bun.lock.overrides");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.overrides = { "@scope/old@npm:ts@^6": { ".": "npm:ts@6.0.3" } };
      }),
    ),
  ).toBe("policy:bun.lock.overrides.@scope/old@npm:ts@^6..");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.overrides = {
          ...fields(lock.overrides),
          "extra@npm:ts@^1": { ".": "npm:ts@1.0.0" },
        };
      }),
    ),
  ).toBe("policy:bun.lock.overrides.extra@npm:ts@^1");
});

test("checkLock resolves an override selector without a registry alias to its own name", async () => {
  const expected = { overrides: { "left-pad": "1.0.0" } };
  const lock = {
    lockfileVersion: 3,
    workspaces: { "": {} },
    overrides: { "left-pad": { ".": "1.0.0" } },
    packages: { "left-pad": ["left-pad@1.0.0"] },
  };
  expect(await lockCause(lock, expected)).toBe("accepted");
  expect(
    await lockCause(
      { ...lock, packages: { "left-pad": ["left-pad@1.0.1"] } },
      expected,
    ),
  ).toBe("policy:bun.lock.packages.left-pad");
});

test("checkLock refuses a root workspace whose dependency groups differ from the policy", async () => {
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = { "": { devDependencies: { eslint: "10.15.0" } } };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root.devDependencies.native");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = {
          "": {
            devDependencies: {
              eslint: "10.15.1",
              native: "npm:ts@7.0.2",
            },
          },
        };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root.devDependencies.eslint");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = {
          "": {
            devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
            dependencies: { extra: "1.0.0" },
          },
        };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root.dependencies.extra");
});

test("checkLock checks the runtime dependency group as well as the dev group", async () => {
  const expected = {
    ...goodExpected(),
    dependencies: { runtime: "2.0.0" },
  };
  const lock = lockWith((value) => {
    value.workspaces = {
      "": {
        devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
        dependencies: { runtime: "2.0.0" },
      },
    };
    value.packages = {
      ...fields(value.packages),
      runtime: ["runtime@2.0.0"],
    };
  });
  expect(await lockCause(lock, expected)).toBe("accepted");
  expect(
    await lockCause(
      lockWith((value) => {
        value.workspaces = {
          "": {
            devDependencies: fields(fields(goodLock().workspaces)[""])
              .devDependencies,
          },
        };
      }),
      expected,
    ),
  ).toBe("policy:bun.lock.workspaces.root.dependencies.runtime");
  expect(
    await lockCause(
      lockWith((value) => {
        value.workspaces = {
          "": {
            devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
            dependencies: { runtime: "2.0.0" },
          },
        };
      }),
      expected,
    ),
  ).toBe("policy:bun.lock.packages.runtime");
});

test("checkLock refuses a dependency group the policy does not write as a document", async () => {
  const lock = lockWith((value) => {
    value.overrides = {};
  });
  for (const group of ["dependencies", "devDependencies"])
    expect(await lockCause(lock, { overrides: {}, [group]: "pinned" })).toBe(
      `policy:package.json.${group}`,
    );
});

test("checkLock refuses a package that resolved to another version or is not recorded", async () => {
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = {
          ...fields(lock.packages),
          eslint: ["eslint@10.15.1"],
        };
      }),
    ),
  ).toBe("policy:bun.lock.packages.eslint");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { ...fields(lock.packages), native: ["ts@7.0.3"] };
      }),
    ),
  ).toBe("policy:bun.lock.packages.native");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { ...fields(lock.packages), eslint: "eslint@10.15.0" };
      }),
    ),
  ).toBe("policy:bun.lock.packages.eslint");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { native: ["ts@7.0.2"], "@scope/old": ["ts@6.0.2"] };
      }),
    ),
  ).toBe("policy:bun.lock.packages.eslint");
});

test("checkLock treats absent dependency groups as empty", async () => {
  const lock = {
    lockfileVersion: 3,
    workspaces: { "": {} },
    overrides: {},
    packages: {},
  };
  expect(await lockCause(lock, { overrides: {} })).toBe("accepted");
});

test("run prints a refusal with the usage line and exits one when the arguments are wrong", async () => {
  const result = await run(["only-one"], environment());
  expect(result.exitCode).toBe(1);
  expect(result.output.endsWith("\n")).toBe(true);
  expect(JSON.parse(result.output)).toEqual({
    status: "refused",
    cause: "usage",
    detail: usage,
  });
  const profile = await run(["a", "huge", "b"], environment());
  expect(profile.exitCode).toBe(1);
  expect(JSON.parse(profile.output)).toEqual({
    status: "refused",
    cause: "usage:profile",
    detail: usage,
  });
});

test("run refuses a project without a package.json after it records the inventory", async () => {
  const project = folder();
  grow(project, { "a.txt": "hello" });
  const evidence = join(folder(), "evidence/nested");
  const result = await run([project, "simple", evidence], environment());
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.output)).toEqual({
    status: "refused",
    cause: "file:missing:package.json",
    detail: "file:missing:package.json",
  });
  expect(
    JSON.parse(readFileSync(join(evidence, "before.json"), "utf8")),
  ).toEqual({
    "a.txt": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  });
  expect(readFileSync(join(evidence, "before.json"), "utf8")).toEndWith("}\n");
});

test("run refuses a symbolic link in the project before it reads any policy", async () => {
  const project = folder();
  grow(project, { "a.txt": "x" });
  symlinkSync(join(project, "a.txt"), join(project, "link.txt"));
  const result = await run(
    [project, "simple", join(folder(), "evidence")],
    environment(),
  );
  expect(JSON.parse(result.output)).toMatchObject({
    status: "refused",
    cause: "scope:symlink:link.txt",
  });
});

test("run reports an unexpected failure as an admission error with its message", async () => {
  const missing = join(folder(), "not-there");
  const result = await run(
    [missing, "simple", join(folder(), "evidence")],
    environment(),
  );
  expect(result.exitCode).toBe(1);
  const printed = fields(JSON.parse(result.output));
  expect(printed).toMatchObject({
    status: "refused",
    cause: "admission:error",
  });
  expect(printed.detail).toContain("ENOENT");
});
