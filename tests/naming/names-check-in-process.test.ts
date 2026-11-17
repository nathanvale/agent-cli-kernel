import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  type Environment,
  type Outcome,
  runNamesCheck,
} from "../../scripts/check-names.ts";
import {
  namesOnPaths,
  type RecordedHit,
  recordedHitsFile,
  stagedNewPaths,
  stagedText,
} from "../../scripts/glossary.ts";
import { git, gitEnv, gitResult, inherited } from "../support/git-fixture.ts";
import { processWatchdog } from "../support/process.ts";
import { testFolder } from "../support/test-folder.ts";

const usage =
  "Usage: bun run check:names <path> [path ...] | --staged | --tool-call";
const glossary = `# Fixture glossary

**Planted fault**:
A deliberate break in a guard.
_Avoid_: mutant, mutation

**Recorded hit**:
A violation listed so that its check passes.
_Avoid_: known hit, allowlist

_Qualify_: host, proof
`;
const hostRefusal =
  'docs/host.md uses "host" with no qualifier. Repair: add a word that says which host it is.\n';
const allowlistRefusal =
  'src/allowlist uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.\n';
const proofRefusal =
  'src/allowlist/proof uses "proof" with no qualifier. Repair: add a word that says which proof it is.\n';
const hostHit: RecordedHit = {
  path: "docs/host.md",
  word: "host",
  reason: "fixture",
};
const folders: string[] = [];
const withheldFromGit = new Map<string, string>();
const isolatedFromUser = new Map<string, string | undefined>();

beforeAll(() => {
  const kept = inherited();
  for (const [name, value] of Object.entries(process.env))
    if (!(name in kept) && value !== undefined) {
      withheldFromGit.set(name, value);
      delete process.env[name];
    }
  for (const [name, value] of Object.entries(gitEnv)) {
    isolatedFromUser.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterAll(() => {
  for (const [name, value] of withheldFromGit) process.env[name] = value;
  for (const [name, value] of isolatedFromUser)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const root = testFolder("names-in-process-");
  folders.push(root);
  return root;
}

function outsideRepository(): string {
  const root = folder();
  const probe = gitResult(root, "rev-parse", "--show-toplevel");
  if (probe.exitCode === 0)
    throw new Error(
      `${root} sits inside the repository at ${probe.stdout.toString().trim()}, so a case that needs no repository would find it. Repair: point STATE_TEST_DIR at a folder with no repository above it, or unset it. Done when git rev-parse --show-toplevel fails in ${root}.`,
    );
  return root;
}

async function whileGitHangs<T>(run: () => T | Promise<T>): Promise<T> {
  const bin = folder();
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 60\n", {
    mode: 0o755,
  });
  const chosen = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${chosen ?? ""}`;
  try {
    return await run();
  } finally {
    if (chosen === undefined) delete process.env.PATH;
    else process.env.PATH = chosen;
  }
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function emptyRepository(): string {
  const root = folder();
  git(root, "init", "--quiet", "--initial-branch=main");
  return root;
}

function namesRepository(recorded: readonly RecordedHit[] = []): string {
  const root = emptyRepository();
  put(root, "GLOSSARY.md", glossary);
  put(root, recordedHitsFile, JSON.stringify({ hits: recorded }));
  git(root, "add", "--", "GLOSSARY.md", recordedHitsFile);
  git(root, "commit", "--quiet", "-m", "rules");
  return root;
}

function stage(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    put(root, path, content);
    git(root, "add", "--", path);
  }
}

function commitAll(root: string, files: Record<string, string>): void {
  stage(root, files);
  git(root, "commit", "--quiet", "-m", "base");
}

function environmentFor(
  root: string,
  stdin: () => Promise<string> = () => Promise.resolve(""),
  cwd: string = root,
): Environment {
  return { root, cwd, stdin };
}

function check(
  root: string,
  args: readonly string[],
  stdin?: () => Promise<string>,
  cwd?: string,
): Promise<Outcome> {
  return runNamesCheck(args, environmentFor(root, stdin, cwd));
}

function hook(call: unknown): () => Promise<string> {
  return () => Promise.resolve(JSON.stringify(call));
}

function writeCall(filePath: string, cwd?: string) {
  return {
    tool_name: "Write",
    tool_input: { file_path: filePath },
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function patchCall(...hunks: string[]) {
  return {
    tool_name: "apply_patch",
    tool_input: {
      command: ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n"),
    },
  };
}

class ClosedEarly {
  readonly name = "ClosedEarly";
  readonly message = "closed";

  toString(): string {
    return "input closed early";
  }
}

function thrownBy(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

test.each([
  [
    "an Avoid word",
    "docs/mutation-notes.md",
    'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: rename it with the glossary word.\n',
  ],
  ["a qualify word alone", "docs/host.md", hostRefusal],
])(
  "in process: a given path that uses %s is refused with its word and repair",
  async (_kind, path, line) => {
    expect(await check(namesRepository(), [path])).toEqual({
      stderr: line,
      code: 1,
    });
  },
);

test("in process: given paths that use only glossary words pass in silence", async () => {
  expect(
    await check(namesRepository(), [
      "docs/planted-fault-notes.md",
      "src/test-host.ts",
    ]),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: a recorded hit passes the given path it covers", async () => {
  expect(await check(namesRepository([hostHit]), ["docs/host.md"])).toEqual({
    stderr: "",
    code: 0,
  });
});

test("in process: every folder on the given paths is judged once, by its own name", async () => {
  expect(
    await check(namesRepository(), [
      "src/allowlist/proof/index.ts",
      "src/allowlist/other.ts",
    ]),
  ).toEqual({ stderr: allowlistRefusal + proofRefusal, code: 1 });
});

test("in process: an absolute path inside the root is judged by its path from the root", async () => {
  const root = namesRepository();
  expect(await check(root, [join(root, "docs/host.md")])).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
});

test("in process: a relative path is resolved from the folder the check runs in, and judged by its path from the root", async () => {
  const root = namesRepository();
  const docs = join(root, "docs");
  const elsewhere = folder();
  mkdirSync(docs);
  expect(await check(root, ["host.md"], undefined, docs)).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
  expect(await check(root, ["../docs/host.md"], undefined, docs)).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
  expect(await check(root, ["host.md"], undefined, elsewhere)).toEqual({
    stderr: `${usage}. host.md is outside this repository.\n`,
    code: 2,
  });
});

test.each([
  ["no path", [], "Give at least one path, --staged or --tool-call."],
  ["an option it does not know", ["--stagd"], 'Unknown option "--stagd".'],
  [
    "an unknown option after a path",
    ["docs/host.md", "--x"],
    'Unknown option "--x".',
  ],
  [
    "a path beside --staged",
    ["--staged", "docs/host.md"],
    "--staged takes no path.",
  ],
  [
    "a path beside --tool-call",
    ["--tool-call", "docs/host.md"],
    "--tool-call takes no path.",
  ],
  [
    "a path outside the root",
    ["../elsewhere/host.ts"],
    "../elsewhere/host.ts is outside this repository.",
  ],
  ["the root itself", ["."], ". is outside this repository."],
  [
    "a folder whose name only begins with two dots",
    ["..hidden/notes.md"],
    null,
  ],
])(
  "in process: %s is judged as a usage matter",
  async (_kind, args, reason) => {
    const outcome = await check(namesRepository(), args);
    expect(outcome).toEqual(
      reason === null
        ? { stderr: "", code: 0 }
        : { stderr: `${usage}. ${reason}\n`, code: 2 },
    );
  },
);

test("in process: a check that cannot run exits 2 without the usage line", async () => {
  const root = namesRepository();
  put(root, recordedHitsFile, "{}");
  expect(await check(root, ["docs/host.md"])).toEqual({
    stderr: `${recordedHitsFile} has no "hits" array. Repair: add "hits": [] at its top level.\n`,
    code: 2,
  });
});

test("in process: standard input is read only for --tool-call", async () => {
  const root = namesRepository();
  const unread = () => Promise.reject(new Error("stdin was read"));
  expect(await check(root, ["docs/host.md"], unread)).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
  expect(await check(root, ["--staged"], unread)).toEqual({
    stderr: "",
    code: 0,
  });
});

test("in process: --staged judges an added and a renamed name, and ignores a modified, a deleted and a given one", async () => {
  const root = namesRepository();
  const body = "A file long enough for git to see its move as a rename.\n";
  commitAll(root, {
    "docs/mutation-notes.md": "before\n",
    "docs/planted-fault-notes.md": body,
    "docs/removed-mutation.md": "gone\n",
  });
  stage(root, { "docs/mutation-notes.md": "after\n" });
  git(root, "rm", "--quiet", "--", "docs/removed-mutation.md");
  expect(await check(root, ["--staged"])).toEqual({ stderr: "", code: 0 });
  git(root, "mv", "docs/planted-fault-notes.md", "docs/host.md");
  stage(root, { "src/allowlist.ts": "" });
  expect(await check(root, ["--staged"])).toEqual({
    stderr: [
      hostRefusal,
      'src/allowlist.ts uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.\n',
    ].join(""),
    code: 1,
  });
});

test("in process: --staged refuses a name whose recorded hit is only an unstaged edit", async () => {
  const root = namesRepository();
  stage(root, { "docs/host.md": "notes\n" });
  put(root, recordedHitsFile, JSON.stringify({ hits: [hostHit] }));
  expect(await check(root, ["--staged"])).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
});

test("in process: --staged passes a name whose recorded hit is staged, though the working tree has lost it", async () => {
  const root = namesRepository();
  stage(root, {
    "docs/host.md": "notes\n",
    [recordedHitsFile]: JSON.stringify({ hits: [hostHit] }),
  });
  put(root, recordedHitsFile, JSON.stringify({ hits: [] }));
  expect(await check(root, ["--staged"])).toEqual({ stderr: "", code: 0 });
});

test("in process: --staged refuses a name that uses an Avoid word only the staged glossary lists", async () => {
  const root = namesRepository();
  stage(root, {
    "GLOSSARY.md": glossary.replace("mutant, mutation", "mutant, canary"),
    "docs/canary-notes.md": "notes\n",
  });
  put(root, "GLOSSARY.md", glossary);
  expect(await check(root, ["--staged"])).toEqual({
    stderr:
      'docs/canary-notes.md uses "canary", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: rename it with the glossary word.\n',
    code: 1,
  });
});

test.each([["GLOSSARY.md"], [recordedHitsFile]])(
  "in process: --staged with no staged %s cannot run, and names the file and the repair",
  async (path) => {
    const root = namesRepository();
    git(root, "rm", "--cached", "--quiet", "--", path);
    expect(await check(root, ["--staged"])).toEqual({
      stderr: `git has no staged ${path}, so the names check cannot judge a commit by the ${path} it will contain. Repair: stage it with git add ${path}, then run the names check again.\n`,
      code: 2,
    });
  },
);

test("in process: a folder meant to sit outside any repository is refused when STATE_TEST_DIR puts a repository above it", () => {
  const above = namesRepository();
  const chosen = process.env.STATE_TEST_DIR;
  process.env.STATE_TEST_DIR = above;
  try {
    expect(thrownBy(outsideRepository)).toContain(
      `sits inside the repository at ${above}, so a case that needs no repository would find it.`,
    );
  } finally {
    if (chosen === undefined) delete process.env.STATE_TEST_DIR;
    else process.env.STATE_TEST_DIR = chosen;
  }
});

test("in process: --staged outside a git repository exits 2 with git's reason", async () => {
  const outcome = await check(outsideRepository(), ["--staged"]);
  expect(outcome.code).toBe(2);
  expect(outcome.stderr).toStartWith(
    "git diff --cached --name-only --diff-filter=ACR failed: ",
  );
  expect(outcome.stderr).toEndWith("\n");
});

test(
  "in process: --staged with a git that never answers exits 2 at its bound, naming the command and the repair",
  async () => {
    const root = namesRepository();
    const command = "git diff --cached --name-only --diff-filter=ACR -z";
    expect(await whileGitHangs(() => check(root, ["--staged"]))).toEqual({
      stderr: `names check: ${command} did not exit within 10000 ms. Repair: find what holds git in ${root} (a stale index.lock, a hung hook or a stalled disk), then run the check again. Done when ${command} exits 0 there.\n`,
      code: 2,
    });
  },
  processWatchdog(1),
);

test(
  "in process: the fixture's git stops a call that never answers at its bound",
  async () => {
    const root = namesRepository();
    expect(await whileGitHangs(() => thrownBy(() => git(root, "status")))).toBe(
      "git status did not exit within 4000 ms.",
    );
  },
  processWatchdog(1),
);

test("in process: --tool-call refuses a Write that creates a badly named file", async () => {
  const root = namesRepository();
  expect(
    await check(root, ["--tool-call"], hook(writeCall("docs/host.md", root))),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call judges each new folder and the new file once", async () => {
  const root = namesRepository();
  put(root, "src/kept.ts", "");
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(writeCall("src/allowlist/proof/index.ts", root)),
    ),
  ).toEqual({ stderr: allowlistRefusal + proofRefusal, code: 1 });
});

test("in process: --tool-call leaves a file or folder that already exists unjudged", async () => {
  const root = namesRepository();
  put(root, "docs/host.md", "old\n");
  put(root, "src/allowlist/kept.ts", "");
  expect(
    await check(root, ["--tool-call"], hook(writeCall("docs/host.md", root))),
  ).toEqual({ stderr: "", code: 0 });
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(writeCall("src/allowlist/proof/index.ts", root)),
    ),
  ).toEqual({ stderr: proofRefusal, code: 1 });
});

test("in process: --tool-call resolves a relative path from the call's folder", async () => {
  const root = namesRepository();
  const docs = join(root, "docs");
  mkdirSync(docs);
  expect(
    await check(root, ["--tool-call"], hook(writeCall("host.md", docs))),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call resolves a relative folder of the call from the injected folder, not the process's own", async () => {
  const root = namesRepository([hostHit]);
  mkdirSync(join(root, "docs"));
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(writeCall("host.md", "docs")),
      root,
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: --tool-call resolves a relative path from the process folder when the call names none", async () => {
  const root = namesRepository();
  const docs = join(root, "docs");
  mkdirSync(docs);
  expect(
    await check(root, ["--tool-call"], hook(writeCall("host.md")), docs),
  ).toEqual({ stderr: hostRefusal, code: 1 });
  expect(
    await check(
      root,
      ["--tool-call"],
      hook({ ...writeCall("host.md"), cwd: 7 }),
      docs,
    ),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call judges a file by the repository that owns it, not the root it is given", async () => {
  const given = namesRepository();
  const owner = namesRepository();
  expect(
    await check(
      given,
      ["--tool-call"],
      hook(writeCall(join(owner, "docs/host.md"), given)),
    ),
  ).toEqual({ stderr: hostRefusal, code: 1 });
  put(owner, recordedHitsFile, JSON.stringify({ hits: [hostHit] }));
  expect(
    await check(
      given,
      ["--tool-call"],
      hook(writeCall(join(owner, "docs/host.md"), given)),
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: --tool-call passes a file outside any repository, and in one with no names check", async () => {
  const outside = outsideRepository();
  expect(
    await check(
      outside,
      ["--tool-call"],
      hook(writeCall(join(outside, "docs/host.md"), outside)),
    ),
  ).toEqual({ stderr: "", code: 0 });
  const bare = emptyRepository();
  expect(
    await check(bare, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: "", code: 0 });
  put(bare, recordedHitsFile, JSON.stringify({ hits: [] }));
  expect(
    await check(bare, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: "", code: 0 });
  rmSync(join(bare, recordedHitsFile));
  put(bare, "GLOSSARY.md", glossary);
  expect(
    await check(bare, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: "", code: 0 });
  put(bare, recordedHitsFile, JSON.stringify({ hits: [] }));
  expect(
    await check(bare, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call reads each file an apply_patch adds or moves to, and no other hunk", async () => {
  const root = namesRepository();
  put(root, "docs/proof-old.md", "");
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(
        patchCall(
          "*** Add File: docs/host.md",
          "+notes",
          "*** Update File: docs/mutation-update.md",
          "@@",
          "-a",
          "+b",
          "*** Delete File: docs/mutation-delete.md",
          "*** Update File: docs/proof-old.md",
          "*** Move to: docs/allowlist-moved.md",
          "@@",
          "-a",
          "+b",
        ),
      ),
    ),
  ).toEqual({
    stderr: [
      hostRefusal,
      'docs/allowlist-moved.md uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.\n',
    ].join(""),
    code: 1,
  });
});

test("in process: --tool-call reads a *** Add File line only at the start of a line", async () => {
  expect(
    await check(
      namesRepository(),
      ["--tool-call"],
      hook(
        patchCall(
          "*** Update File: docs/notes.md",
          "+*** Add File: docs/host.md",
          "+ *** Move to: docs/host.md",
        ),
      ),
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: a check that fails with something other than an Error reports it as text", async () => {
  const failure: Error = new ClosedEarly();
  expect(
    await check(namesRepository(), ["--tool-call"], () =>
      Promise.reject(failure),
    ),
  ).toEqual({ stderr: "input closed early\n", code: 2 });
});

test("in process: --tool-call passes an apply_patch that adds no file", async () => {
  expect(
    await check(
      namesRepository(),
      ["--tool-call"],
      hook(patchCall("*** Delete File: docs/mutation-delete.md")),
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test.each([
  ["a tool it does not read", { tool_name: "Bash", tool_input: {} }, "Bash"],
  ["a call with no tool", { tool_input: {} }, "undefined"],
  ["a call that is not an object", null, "undefined"],
])(
  "in process: --tool-call refuses %s and names the two tools it reads",
  async (_kind, call, tool) => {
    expect(await check(namesRepository(), ["--tool-call"], hook(call))).toEqual(
      {
        stderr: `--tool-call reads a Write call's file_path and an apply_patch call's command, not a ${tool} call. Repair: wire the names check hook to those two tools.\n`,
        code: 2,
      },
    );
  },
);

test.each([
  ["Write", "file_path", "a number", { tool_input: { file_path: 7 } }],
  ["Write", "file_path", "no object", { tool_input: null }],
  ["apply_patch", "command", "a list", { tool_input: { command: ["x"] } }],
  ["apply_patch", "command", "a string", { tool_input: "patch" }],
])(
  "in process: --tool-call refuses a %s call whose tool_input has no string %s (%s)",
  async (tool, field, _kind, rest) => {
    expect(
      await check(
        namesRepository(),
        ["--tool-call"],
        hook({ tool_name: tool, ...rest }),
      ),
    ).toEqual({
      stderr: `--tool-call got a ${tool} call whose tool_input has no string ${field}, so it cannot tell which names the call creates. Repair: pass the tool call as the hook receives it.\n`,
      code: 2,
    });
  },
);

test("in process: --tool-call given input that is not JSON exits 2 with the parser's reason", async () => {
  const outcome = await check(namesRepository(), ["--tool-call"], () =>
    Promise.resolve("not json"),
  );
  expect(outcome.code).toBe(2);
  expect(outcome.stderr).not.toStartWith(usage);
  expect(outcome.stderr).toEndWith("\n");
  expect(outcome.stderr.length).toBeGreaterThan(1);
});

test("in process: namesOnPaths lists each path and each folder above it once, in first-seen order", () => {
  expect(namesOnPaths([])).toEqual([]);
  expect(namesOnPaths(["README.md"])).toEqual(["README.md"]);
  expect(namesOnPaths(["a/b/c.ts"])).toEqual(["a", "a/b", "a/b/c.ts"]);
  expect(namesOnPaths(["src/a.ts", "src/b/c.ts", "src/a.ts"])).toEqual([
    "src",
    "src/a.ts",
    "src/b",
    "src/b/c.ts",
  ]);
});

test("in process: stagedNewPaths lists staged additions and renames, and no modification or deletion", () => {
  const root = emptyRepository();
  const body = "A file long enough for git to see its move as a rename.\n";
  commitAll(root, {
    "docs/edited.md": "before\n",
    "docs/moved.md": body,
    "docs/removed.md": "gone\n",
  });
  expect(stagedNewPaths(root)).toEqual([]);
  stage(root, {
    "docs/edited.md": "after\n",
    "docs/added.md": "new\n",
    "docs/with space.md": "new\n",
    "docs/café.md": "new\n",
  });
  git(root, "mv", "docs/moved.md", "docs/renamed.md");
  git(root, "rm", "--quiet", "--", "docs/removed.md");
  put(root, "docs/unstaged.md", "untracked\n");
  expect(stagedNewPaths(root).sort()).toEqual([
    "docs/added.md",
    "docs/café.md",
    "docs/renamed.md",
    "docs/with space.md",
  ]);
});

test("in process: stagedNewPaths lists names in git's own order, whatever the user's git configuration says", () => {
  const root = emptyRepository();
  const home = folder();
  put(home, "order", "docs/z.md\n");
  put(home, ".gitconfig", `[diff]\n\torderFile = ${join(home, "order")}\n`);
  stage(root, { "docs/a.md": "a\n", "docs/z.md": "z\n" });
  const chosen = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(stagedNewPaths(root)).toEqual(["docs/a.md", "docs/z.md"]);
  } finally {
    if (chosen === undefined) delete process.env.HOME;
    else process.env.HOME = chosen;
  }
});

test("in process: stagedNewPaths outside a git repository names the command and git's reason", () => {
  const message = thrownBy(() => stagedNewPaths(outsideRepository()));
  expect(message).toStartWith(
    "git diff --cached --name-only --diff-filter=ACR failed: ",
  );
  expect(message.length).toBeGreaterThan(
    "git diff --cached --name-only --diff-filter=ACR failed: ".length,
  );
});

test("in process: stagedText returns the staged content, not the committed or the working one", () => {
  const root = emptyRepository();
  commitAll(root, { "docs/note.md": "committed\n" });
  stage(root, { "docs/note.md": "staged\n\n" });
  put(root, "docs/note.md", "working");
  expect(stagedText(root, "docs/note.md")).toBe("staged\n\n");
});

test("in process: stagedText of a path git has not staged names the path and the repair", () => {
  const root = emptyRepository();
  put(root, "docs/note.md", "working\n");
  expect(thrownBy(() => stagedText(root, "docs/note.md"))).toBe(
    "git has no staged docs/note.md, so the names check cannot judge a commit by the docs/note.md it will contain. Repair: stage it with git add docs/note.md, then run the names check again.",
  );
});
