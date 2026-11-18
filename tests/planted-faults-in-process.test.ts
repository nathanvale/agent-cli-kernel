import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  add,
  type Fault,
  faultsTouchedSince,
  readRecords,
  replay,
  replayAll,
  report,
  stepLimitMilliseconds,
  type Verdict,
} from "../scripts/planted-faults.ts";
import { testFolder } from "./support/test-folder.ts";

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

const recordsPath = "tests/planted-faults/fault-records.json";
const stepVariable = "FAULT_REPLAY_STEP_SECONDS";
const repositoryLocation = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];
const fixtureAuthor = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const unguarded = `export function limit(value: number): number {
  return value;
}
`;
const guarded = `export function limit(value: number): number {
  if (Number.isNaN(value)) throw new TypeError("limit must be a number");
  return value;
}
`;
const limitTests = `import { expect, test } from "bun:test";
import { limit } from "../src/limit.ts";

test("L.refuses NaN", () => {
  expect(() => limit(Number.NaN)).toThrow("limit must be a number");
});
test("L.refuses NaN twice", () => {
  expect(() => limit(Number.NaN)).toThrow("limit must be a number");
});
test("L.weak keeps a number", () => {
  expect(limit(1)).toBe(1);
});
`;
const killedBy = ["L.refuses NaN", "L.refuses NaN twice"];
const redTest = `test("L.red is red without the fault", () => {
  expect(limit(1)).toBe(2);
});
`;

function folder(prefix: string): string {
  const path = testFolder(prefix);
  folders.push(path);
  return path;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !repositoryLocation.includes(name),
        ),
      ),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...fixtureAuthor,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(
  root: string,
  subject: string,
  files: Record<string, string>,
): string {
  for (const [path, content] of Object.entries(files)) {
    write(root, path, content);
    git(root, "add", "--", path);
  }
  git(root, "commit", "--quiet", "-m", subject);
  return git(root, "rev-parse", "--short", "HEAD").trim();
}

function worktrees(root: string): string[] {
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function repository(prefix: string): string {
  const root = join(folder(prefix), "repo");
  mkdirSync(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  return root;
}

type Planted = {
  root: string;
  fix: string;
  id: string;
  patch: string;
  fault: Fault;
};

function planted(
  options: {
    tests?: string;
    manifest?: string;
    title?: string;
    elsewhere?: string;
  } = {},
): Planted {
  const root = repository("planted-faults-fixture-");
  commit(root, "base", {
    "package.json":
      options.manifest ?? JSON.stringify({ name: "fixture", private: true }),
    ".gitignore": "node_modules/\n",
    "src/limit.ts": unguarded,
  });
  const fix = commit(root, "fix: refuse a NaN limit", {
    "src/limit.ts": guarded,
    "tests/limit.test.ts": options.tests ?? limitTests,
    ...(options.elsewhere === undefined
      ? {}
      : { "tests/elsewhere.test.ts": options.elsewhere }),
  });
  const id = `${fix}-limit`;
  const patch = git(root, "diff", "HEAD", "HEAD~1", "--", "src/limit.ts");
  const fault: Fault = {
    id,
    patch: `tests/planted-faults/patches/${id}.patch`,
    testFile: "tests/limit.test.ts",
    title: options.title ?? "^L\\.refuses ",
    source: `${fix} fix: refuse a NaN limit`,
  };
  write(root, fault.patch, patch);
  return { root, fix, id, patch, fault };
}

function headOf(root: string): string {
  return git(root, "rev-parse", "HEAD").trim();
}

function recorded(root: string, faults: readonly Fault[]): void {
  for (const fault of faults)
    if (!existsSync(join(root, fault.patch)))
      write(root, fault.patch, "unused\n");
  write(root, recordsPath, `${JSON.stringify(faults, null, 2)}\n`);
  git(root, "add", "--", "tests/planted-faults");
  git(root, "commit", "--quiet", "-m", "record the faults");
}

async function captured<T>(run: () => Promise<T> | T) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    },
  );
  const stderr = spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    },
  );
  try {
    const result = await run();
    return { result, stdout: out.join(""), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

async function isolated<T>(run: () => Promise<T> | T) {
  const scratch = folder("planted-faults-scratch-");
  const changes: Record<string, string | undefined> = {
    TMPDIR: scratch,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...Object.fromEntries(repositoryLocation.map((name) => [name, undefined])),
  };
  const before = Object.fromEntries(
    Object.keys(changes).map((name) => [name, process.env[name]]),
  );
  const set = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
  set(changes);
  try {
    const result = await captured(run);
    return { ...result, leftovers: readdirSync(scratch) };
  } finally {
    set(before);
  }
}

async function rejection(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The call resolved, but the test expected it to reject.");
}

function outputOf(verdict: Verdict): string {
  if (verdict.kind === "STALE" || verdict.kind === "BROKEN")
    return verdict.output;
  throw new Error(`${verdict.kind} carries no output.`);
}

const sample: Fault = {
  id: "abc1234-limit",
  patch: "tests/planted-faults/patches/abc1234-limit.patch",
  testFile: "tests/limit.test.ts",
  title: "^L\\.refuses ",
  source: "abc1234 fix: refuse a NaN limit",
};

describe("readRecords", () => {
  function recordsIn(content: string | null, files: string[] = []): string {
    const root = folder("planted-faults-records-");
    for (const file of files) write(root, file, "");
    if (content !== null) write(root, recordsPath, content);
    return root;
  }

  test("gives no records when the records file is absent", () => {
    expect(readRecords(recordsIn(null))).toEqual([]);
  });

  test("reads each record in file order, with every field", () => {
    const other: Fault = { ...sample, id: "def5678-other" };
    const root = recordsIn(JSON.stringify([sample, other]), [
      "tests/limit.test.ts",
    ]);

    expect(readRecords(root)).toEqual([sample, other]);
  });

  test("keeps only the five named fields of a record", () => {
    const root = recordsIn(JSON.stringify([{ ...sample, extra: "ignored" }]), [
      "tests/limit.test.ts",
    ]);

    expect(readRecords(root)).toEqual([sample]);
  });

  test("refuses a file whose top level is not an array", () => {
    const root = recordsIn(JSON.stringify({ id: "x" }));

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} must hold an array of fault records. Repair: make its top level one JSON array.`,
    );
  });

  test("refuses a file that is not JSON", () => {
    const root = recordsIn("not json");

    expect(() => readRecords(root)).toThrow("JSON Parse error");
  });

  test("refuses an id listed twice and names it", () => {
    const root = recordsIn(JSON.stringify([sample, sample]), [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} lists abc1234-limit twice. Repair: remove one record, or give it another id.`,
    );
  });

  test.each([
    ["id", "name it <fix short sha>-<source file name>."],
    [
      "patch",
      "name the planted fault's patch under tests/planted-faults/patches.",
    ],
    ["testFile", "name a test file relative to the repository root."],
    [
      "title",
      "name the bun test -t pattern that selects the test that kills the planted fault.",
    ],
    ["source", "name it <fix short sha> <fix subject>."],
  ])("refuses a record with no %s and gives its repair", (field, repair) => {
    const record: Record<string, string> = { ...sample };
    delete record[field];
    const root = recordsIn(JSON.stringify([sample, record]), [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} record 1 needs a non-empty string ${field}. Repair: ${repair}`,
    );
  });

  test("refuses a record whose field is empty or not text", () => {
    const empty = recordsIn(JSON.stringify([{ ...sample, title: "" }]), [
      "tests/limit.test.ts",
    ]);
    const number = recordsIn(JSON.stringify([{ ...sample, patch: 3 }]), [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(empty)).toThrow(
      `${recordsPath} record 0 needs a non-empty string title.`,
    );
    expect(() => readRecords(number)).toThrow(
      `${recordsPath} record 0 needs a non-empty string patch.`,
    );
  });

  test.each([
    ["null", "null"],
    ["a string", '"abc"'],
    ["a number", "7"],
  ])("refuses a record that is %s", (_name, entry) => {
    const root = recordsIn(`[${entry}]`);

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} record 0 needs a non-empty string id.`,
    );
  });

  test("refuses a record whose test file does not exist", () => {
    const root = recordsIn(JSON.stringify([sample]));

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} record 0 names testFile tests/limit.test.ts, which does not exist. Repair: name a test file relative to the repository root.`,
    );
  });

  test("reads the file under the root it is given, not another", () => {
    const left = recordsIn(JSON.stringify([sample]), ["tests/limit.test.ts"]);
    const right = recordsIn(null);

    expect(readRecords(left)).toEqual([sample]);
    expect(readRecords(right)).toEqual([]);
  });
});

describe("stepLimitMilliseconds", () => {
  test.each([
    ["unset", {}],
    ["empty", { [stepVariable]: "" }],
  ])("gives 300 s when the variable is %s", (_name, env) => {
    expect(stepLimitMilliseconds(env)).toBe(300_000);
  });

  test.each([
    ["10", 10_000],
    ["2.5", 2_500],
    ["0.001", 1],
    ["1e3", 1_000_000],
  ])("reads %s seconds as %d ms", (given, milliseconds) => {
    expect(stepLimitMilliseconds({ [stepVariable]: given })).toBe(milliseconds);
  });

  test.each(["0", "-1", "abc", "Infinity", "NaN", " "])(
    "refuses %j and names the repair",
    (given) => {
      expect(() => stepLimitMilliseconds({ [stepVariable]: given })).toThrow(
        `${stepVariable} is '${given}'. Repair: set it to a positive number of seconds, or unset it for 300 s.`,
      );
    },
  );

  test("quotes a single quote in the refused value", () => {
    expect(() => stepLimitMilliseconds({ [stepVariable]: "it's" })).toThrow(
      `${stepVariable} is 'it'\\''s'.`,
    );
  });

  test("reads the given environment, not the process's own", () => {
    const own = process.env[stepVariable];

    expect(stepLimitMilliseconds({ [stepVariable]: "4" })).toBe(4_000);
    expect(process.env[stepVariable]).toBe(own);
  });
});

describe("report", () => {
  const done = "Done when bun run fault-replay abc1234-limit passes.";
  const shown = "bun test ./tests/limit.test.ts -t '^L\\.refuses '";

  async function reported(verdict: Verdict, seconds = 12.34, limit = 2_500) {
    const { result, stdout, stderr } = await captured(() =>
      report(sample, verdict, seconds, limit),
    );
    expect(result).toBeUndefined();
    expect(stderr).toBe("");
    return stdout;
  }

  test("KILLED lists the failing tests in order", async () => {
    expect(await reported({ kind: "KILLED", failing: ["L.a", "L.b"] })).toBe(
      "KILLED abc1234-limit in 12.3 s. Failed: L.a | L.b\n",
    );
  });

  test("KILLED with no failing test says the test file did not load", async () => {
    expect(await reported({ kind: "KILLED", failing: [] }, 0.04)).toBe(
      "KILLED abc1234-limit in 0.0 s. Failed: the test file, which did not load\n",
    );
  });

  test("SURVIVED names the passing command and the repair", async () => {
    expect(await reported({ kind: "SURVIVED" })).toBe(
      `SURVIVED abc1234-limit in 12.3 s. ${shown} passed with ${sample.patch} applied, so no test catches this planted fault.\n` +
        `Repair: change tests/limit.test.ts so that test fails with the patch applied. ${done}\n`,
    );
  });

  test("STALE prints the apply output, then how to plant the fault again", async () => {
    expect(await reported({ kind: "STALE", output: "error: no match" })).toBe(
      `STALE abc1234-limit in 12.3 s. ${sample.patch} no longer applies at this head.\n` +
        "error: no match\n" +
        `Repair: plant the fault again by hand, run git diff -- <each file you edited> > '${sample.patch}', then undo the planted edit. ${done}\n`,
    );
  });

  test("STALE does not add a second newline to output that ends with one", async () => {
    expect(
      await reported({ kind: "STALE", output: "error: no match\n" }),
    ).toContain("applies at this head.\nerror: no match\nRepair: plant");
  });

  test("BROKEN prints the failing output and the repair", async () => {
    expect(await reported({ kind: "BROKEN", output: "(fail) L.red" })).toBe(
      `BROKEN abc1234-limit in 12.3 s. ${shown} fails without the patch, so the planted fault shows nothing.\n` +
        "(fail) L.red\n" +
        `Repair: make that test pass without the patch. ${done}\n`,
    );
  });

  test("BROKEN does not add a second newline to output that ends with one", async () => {
    expect(
      await reported({ kind: "BROKEN", output: "(fail) L.red\n" }),
    ).toContain("shows nothing.\n(fail) L.red\nRepair: make");
  });

  test("TIMEOUT names the step, the limit in seconds and the variable", async () => {
    expect(await reported({ kind: "TIMEOUT", step: "bun install" })).toBe(
      "TIMEOUT abc1234-limit in 12.3 s. bun install did not finish within 2.5 s, so the planted fault has no verdict.\n" +
        `Repair: run that step by hand to see where it hangs, or raise ${stepVariable}. ${done}\n`,
    );
  });

  test("quotes a single quote in the title of the shown command", async () => {
    const { stdout } = await captured(() =>
      report({ ...sample, title: "it's" }, { kind: "SURVIVED" }, 1, 1_000),
    );

    expect(stdout).toContain("-t 'it'\\''s' passed with");
  });
});

describe("replay", () => {
  const limit = 120_000;

  async function replayed(subject: Planted, overrides: Partial<Fault> = {}) {
    return isolated(() =>
      replay(
        subject.root,
        { ...subject.fault, ...overrides },
        headOf(subject.root),
        limit,
      ),
    );
  }

  test("KILLED lists, in file order, every test that fails once the fault is applied", async () => {
    const subject = planted();

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
    expect(run.stdout).toBe("");
  }, 60_000);

  test("SURVIVED when the named test still passes with the fault applied", async () => {
    const subject = planted();

    const run = await replayed(subject, { title: "^L\\.weak " });

    expect(run.result).toEqual({ kind: "SURVIVED" });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("STALE when the patch no longer applies, with git's own words", async () => {
    const subject = planted();
    write(
      subject.root,
      subject.fault.patch,
      subject.patch.replace("return value;", "return other;"),
    );

    const run = await replayed(subject);

    expect(run.result.kind).toBe("STALE");
    expect(outputOf(run.result)).toContain("patch does not apply");
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("BROKEN when the named test already fails without the fault", async () => {
    const subject = planted({
      tests: `${limitTests}${redTest}`,
      title: "^L\\.red ",
    });

    const run = await replayed(subject);

    expect(run.result.kind).toBe("BROKEN");
    expect(outputOf(run.result)).toContain("(fail) L.red is red without");
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("BROKEN when the test file fails to load before the fault", async () => {
    const subject = planted({ tests: "throw new Error('does not load');\n" });

    const run = await replayed(subject);

    expect(run.result.kind).toBe("BROKEN");
    expect(outputOf(run.result)).toContain("does not load");
  }, 60_000);

  test("runs only the test file the record names", async () => {
    const subject = planted({
      elsewhere: `import { test } from "bun:test";

test("L.refuses elsewhere", () => {
  throw new Error("a test in another file");
});
`,
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("refuses to give a verdict when the test run dies by a signal", async () => {
    const subject = planted({
      tests: `import { test } from "bun:test";

test("L.refuses dies", () => {
  process.kill(process.pid, "SIGKILL");
});
`,
    });

    const run = isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), limit),
    );

    expect(await rejection(run)).toBe(
      `${process.execPath} test ./tests/limit.test.ts -t ^L\\.refuses  was killed by SIGKILL while replaying ${subject.id}, so it has no verdict.`,
    );
  }, 60_000);

  test("TIMEOUT names a step of the replay as the one that outran the limit, and cleans up", async () => {
    const subject = planted();

    const run = await isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), 1),
    );

    expect(run.result.kind).toBe("TIMEOUT");
    const step = String(Reflect.get(run.result, "step"));
    const bun = process.execPath;
    expect(
      [
        "git worktree add --detach --quiet ",
        "git apply ",
        `${bun} install --frozen-lockfile`,
        `${bun} test ./tests/`,
      ].some((start) => step.startsWith(start)),
    ).toBe(true);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("refuses a commit git cannot check out, naming git's words", async () => {
    const subject = planted();

    const run = isolated(() =>
      replay(subject.root, subject.fault, "0".repeat(40), limit),
    );

    expect(await rejection(run)).toContain("invalid reference");
  }, 60_000);

  test("refuses when the install fails, naming the fault and the output", async () => {
    const subject = planted({ manifest: "{ not json" });

    const run = isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), limit),
    );

    expect(await rejection(run)).toStartWith(
      `bun install --frozen-lockfile failed while replaying ${subject.id}:\n`,
    );
  }, 60_000);

  test("replays the commit it is given, not the working tree", async () => {
    const subject = planted();
    write(subject.root, "src/limit.ts", unguarded);

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(readFileSync(join(subject.root, "src/limit.ts"), "utf8")).toBe(
      unguarded,
    );
  }, 60_000);
});

describe("replayAll", () => {
  const environment = { [stepVariable]: "120" };

  async function replayedAll(
    root: string,
    ids: readonly string[] = [],
    env: Readonly<Record<string, string | undefined>> = environment,
  ) {
    return isolated(() => replayAll(root, ids, env));
  }

  function killedAndSurvivor(): Planted & { survivor: Fault } {
    const subject = planted();
    const survivor: Fault = {
      ...subject.fault,
      id: "weak",
      title: "^L\\.weak ",
    };
    recorded(subject.root, [subject.fault, survivor]);
    return { ...subject, survivor };
  }

  test("exits 0 and says so when every fault is KILLED", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);

    const run = await replayedAll(subject.root);

    expect(run.result).toBe(0);
    const [verdict, summary, ...rest] = run.stdout.split("\n");
    expect(verdict).toMatch(
      new RegExp(
        `^KILLED ${subject.id} in [\\d.]+ s\\. Failed: L\\.refuses NaN \\| L\\.refuses NaN twice$`,
      ),
    );
    expect(summary).toMatch(
      new RegExp(
        `^1 of 1 planted faults KILLED in [\\d.]+ s, [\\d.]+ s per fault, with Bun ${Bun.version.replaceAll(".", "\\.")}\\.$`,
      ),
    );
    expect(rest).toEqual([""]);
    expect(run.stderr).toBe("");
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays every record in order and exits 1 when one survives", async () => {
    const { root, id } = killedAndSurvivor();
    let wall = 0;

    const run = await isolated(async () => {
      const began = performance.now();
      try {
        return await replayAll(root, [], environment);
      } finally {
        wall = (performance.now() - began) / 1000;
      }
    });

    expect(run.result).toBe(1);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toStartWith(`KILLED ${id} in `);
    expect(lines[1]).toStartWith("SURVIVED weak in ");
    expect(lines[2]).toBe(
      "Repair: change tests/limit.test.ts so that test fails with the patch applied. Done when bun run fault-replay weak passes.",
    );
    expect(lines[3]).toMatch(
      /^1 of 2 planted faults KILLED in [\d.]+ s, [\d.]+ s per fault, with Bun /,
    );
    expect(run.leftovers).toEqual([]);
    const seconds = (line: string | undefined, after: string) =>
      Number(line?.match(new RegExp(`${after}(\\d+\\.\\d)`))?.[1]);
    const first = seconds(lines[0], " in ");
    const second = seconds(lines[1], " in ");
    const total = seconds(lines[3], "KILLED in ");
    const each = seconds(lines[3], " s, ");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(first + second).toBeLessThanOrEqual(total + 0.2);
    expect(total).toBeLessThanOrEqual(wall + 0.06);
    expect(Math.abs(each * 2 - total)).toBeLessThanOrEqual(0.15);
  }, 60_000);

  test("replays only the records its ids name", async () => {
    const { root, id } = killedAndSurvivor();

    const run = await replayedAll(root, [id]);

    expect(run.result).toBe(0);
    expect(run.stdout).not.toContain("SURVIVED");
    expect(run.stdout).toContain("1 of 1 planted faults KILLED in ");
  }, 60_000);

  test("refuses an unknown id before replaying anything", async () => {
    const { root, id } = killedAndSurvivor();

    const run = await replayedAll(root, [id, "nope", "gone"]);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `No fault record nope, gone in ${recordsPath}. Repair: pass an id that file lists.\n`,
    );
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("reports an unknown id before it reads the step limit", async () => {
    const { root } = killedAndSurvivor();

    const run = await replayedAll(root, ["nope"], { [stepVariable]: "x" });

    expect(run.result).toBe(2);
    expect(run.stderr).toContain("No fault record nope in ");
  }, 60_000);

  test.each([
    ["no records file", null],
    ["an empty records list", "[]"],
  ])(
    "exits 1 and says it checks nothing with %s",
    async (_name, content) => {
      const root = repository("planted-faults-empty-");
      commit(root, "base", { "package.json": "{}" });
      if (content !== null) write(root, recordsPath, content);

      const run = await replayedAll(root);

      expect(run.result).toBe(1);
      expect(run.stdout).toBe(
        `${recordsPath} has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.\n`,
      );
      expect(run.stderr).toBe("");
    },
    60_000,
  );

  test("refuses a step limit that is not a positive number", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);

    const run = replayedAll(subject.root, [], { [stepVariable]: "-3" });

    expect(await rejection(run)).toBe(
      `${stepVariable} is '-3'. Repair: set it to a positive number of seconds, or unset it for 300 s.`,
    );
  }, 60_000);

  test("reports TIMEOUT with the limit in seconds and exits 1", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);

    const run = await replayedAll(subject.root, [], {
      [stepVariable]: "0.001",
    });

    expect(run.result).toBe(1);
    expect(run.stdout).toContain(
      "did not finish within 0.001 s, so the planted fault has no verdict.",
    );
    expect(run.stdout).toContain("0 of 1 planted faults KILLED in ");
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays uncommitted and untracked work, leaving the tree as it was", async () => {
    const root = repository("planted-faults-dirty-");
    commit(root, "base", {
      "package.json": JSON.stringify({ name: "fixture", private: true }),
      ".gitignore": "node_modules/\n",
      "src/limit.ts": unguarded,
    });
    const fault: Fault = {
      ...sample,
      id: "dirty-limit",
      patch: "tests/planted-faults/patches/dirty-limit.patch",
    };
    write(root, "src/limit.ts", guarded);
    write(root, fault.patch, git(root, "diff", "-R", "--", "src/limit.ts"));
    write(root, "tests/limit.test.ts", limitTests);
    write(root, recordsPath, `${JSON.stringify([fault], null, 2)}\n`);
    const head = headOf(root);
    const status = git(root, "status", "--porcelain");

    const run = await replayedAll(root);

    expect(run.result).toBe(0);
    expect(run.stdout).toContain(`KILLED ${fault.id} in `);
    expect(headOf(root)).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(guarded);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays a clean tree at its own head", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);
    const head = headOf(subject.root);
    const objects = git(subject.root, "count-objects");

    const run = await replayedAll(subject.root);

    expect(run.result).toBe(0);
    expect(headOf(subject.root)).toBe(head);
    expect(git(subject.root, "status", "--porcelain")).toBe("");
    expect(git(subject.root, "count-objects")).toBe(objects);
  }, 60_000);
});

describe("add", () => {
  function fixed() {
    const root = repository("planted-faults-add-");
    commit(root, "base", {
      "src/limit.ts": unguarded,
      "src/other.ts": "a\n",
      "src/untouched.ts": "a\n",
    });
    const fix = commit(root, "fix: refuse a NaN limit", {
      "src/limit.ts": guarded,
      "src/other.ts": "b\n",
      "tests/limit.test.ts": limitTests,
    });
    const full = git(root, "rev-parse", "HEAD").trim();
    return { root, fix, full };
  }

  async function added(root: string, args: readonly string[]) {
    return isolated(() => add(root, args));
  }

  function savedRecords(root: string): Fault[] {
    return readRecords(root);
  }

  const args = (fix: string) => [
    fix,
    "src/limit.ts",
    "tests/limit.test.ts",
    "^L\\.refuses ",
  ];

  test("stores the fix's reverse hunk and a record naming it", async () => {
    const { root, fix, full } = fixed();

    const run = await added(root, args(fix));

    const id = `${fix}-limit`;
    expect(run.result).toBe(0);
    expect(run.stdout).toBe(
      `Added ${id}. Replay it: bun run fault-replay ${id}\n`,
    );
    expect(run.stderr).toBe("");
    expect(savedRecords(root)).toEqual([
      {
        id,
        patch: `tests/planted-faults/patches/${id}.patch`,
        testFile: "tests/limit.test.ts",
        title: "^L\\.refuses ",
        source: `${fix} fix: refuse a NaN limit`,
      },
    ]);
    expect(
      readFileSync(
        join(root, `tests/planted-faults/patches/${id}.patch`),
        "utf8",
      ),
    ).toBe(git(root, "diff", full, `${full}^`, "--", "src/limit.ts"));
    expect(readFileSync(join(root, recordsPath), "utf8")).toEndWith("}\n]\n");
    expect(run.leftovers).toEqual([]);
  });

  test("the stored patch applies to the fixed tree and removes the fix", async () => {
    const { root, fix } = fixed();
    await added(root, args(fix));

    git(
      root,
      "apply",
      join(root, `tests/planted-faults/patches/${fix}-limit.patch`),
    );

    expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(unguarded);
  });

  test("accepts a full sha and records the short one", async () => {
    const { root, fix, full } = fixed();

    const run = await added(root, [full, ...args(fix).slice(1)]);

    expect(run.result).toBe(0);
    expect(run.stdout).toStartWith(`Added ${fix}-limit.`);
    expect(savedRecords(root)[0]?.source).toBe(
      `${fix} fix: refuse a NaN limit`,
    );
  });

  test("adds to the records already there, in order", async () => {
    const { root, fix } = fixed();
    const first = await added(root, args(fix));
    expect(first.result).toBe(0);

    const second = await added(root, [
      fix,
      "src/other.ts",
      "tests/limit.test.ts",
      "x",
    ]);

    expect(second.result).toBe(0);
    expect(savedRecords(root).map(({ id, title }) => [id, title])).toEqual([
      [`${fix}-limit`, "^L\\.refuses "],
      [`${fix}-other`, "x"],
    ]);
  });

  test("names the id after the source file without its extension", async () => {
    const root = repository("planted-faults-add-name-");
    commit(root, "base", { Makefile: "a\n", "src/x.tar.gz": "a\n" });
    commit(root, "fix: both", { Makefile: "b\n", "src/x.tar.gz": "b\n" });
    write(root, "t.test.ts", "");
    const short = git(root, "rev-parse", "--short", "HEAD").trim();

    const plain = await added(root, [short, "Makefile", "t.test.ts", "t"]);
    const dotted = await added(root, [short, "src/x.tar.gz", "t.test.ts", "t"]);

    expect(plain.result).toBe(0);
    expect(dotted.result).toBe(0);
    expect(savedRecords(root).map(({ id }) => id)).toEqual([
      `${short}-Makefile`,
      `${short}-x.tar`,
    ]);
  });

  test("refuses an id already recorded and leaves the files as they were", async () => {
    const { root, fix } = fixed();
    await added(root, args(fix));
    const records = readFileSync(join(root, recordsPath), "utf8");
    const patchPath = join(
      root,
      `tests/planted-faults/patches/${fix}-limit.patch`,
    );
    writeFileSync(patchPath, "edited by hand\n");

    const run = await added(root, args(fix));

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `${recordsPath} already lists ${fix}-limit. Repair: plant it again by hand, run git diff -- 'src/limit.ts' > 'tests/planted-faults/patches/${fix}-limit.patch', then undo the planted edit; or add the new record by hand under another id.\n`,
    );
    expect(readFileSync(join(root, recordsPath), "utf8")).toBe(records);
    expect(readFileSync(patchPath, "utf8")).toBe("edited by hand\n");
  });

  test.each([
    ["the fix sha", 0],
    ["the source path", 1],
    ["the test file", 2],
    ["the title", 3],
  ])("exits 2 with usage when %s is missing", async (_name, missing) => {
    const { root, fix } = fixed();
    const given = args(fix).slice(0, missing);

    const run = await added(root, given);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "Usage: bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
  });

  test("exits 2 and names the short sha when the fix leaves the source path alone", async () => {
    const { root, fix } = fixed();

    const run = await added(root, [
      fix,
      "src/untouched.ts",
      "tests/limit.test.ts",
      "t",
    ]);

    expect(run.result).toBe(2);
    expect(run.stderr).toBe(
      `${fix} does not change src/untouched.ts. Repair: pass a path that git diff --name-only ${fix}^ ${fix} lists.\n`,
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
    expect(existsSync(join(root, "tests/planted-faults"))).toBe(false);
  });

  test("refuses a sha that is no commit, in git's words", async () => {
    const { root } = fixed();

    const run = added(root, [
      "nope",
      "src/limit.ts",
      "tests/limit.test.ts",
      "t",
    ]);

    expect(await rejection(run)).toStartWith(
      "git rev-parse --verify nope^{commit}:",
    );
  });

  test("refuses a test file that does not exist and writes nothing", async () => {
    const { root, fix } = fixed();

    const run = added(root, [
      fix,
      "src/limit.ts",
      "tests/missing.test.ts",
      "t",
    ]);

    expect(await rejection(run)).toBe(
      "planted-fault:add names testFile tests/missing.test.ts, which does not exist. Repair: name a test file relative to the repository root.",
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
    expect(existsSync(join(root, "tests/planted-faults"))).toBe(false);
  });

  test("works in the repository it is given, not the working directory's", async () => {
    const { root, fix } = fixed();
    const elsewhere = repository("planted-faults-add-elsewhere-");
    commit(elsewhere, "base", { "src/limit.ts": "x\n" });

    const run = await added(root, args(fix));

    expect(run.result).toBe(0);
    expect(existsSync(join(elsewhere, recordsPath))).toBe(false);
    expect(readdirSync(join(root, "tests/planted-faults")).sort()).toEqual([
      "fault-records.json",
      "patches",
    ]);
  });
});

describe("faultsTouchedSince", () => {
  const other: Fault = {
    id: "def5678-other",
    patch: "tests/planted-faults/patches/def5678-other.patch",
    testFile: "tests/limit.test.ts",
    title: "^L\\.weak ",
    source: "def5678 fix: other",
  };
  const otherPatch = `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-export const other = 2;
+export const other = 1;
`;

  function twoFaults() {
    const fixture = planted();
    commit(fixture.root, "add other", {
      "src/other.ts": "export const other = 2;\n",
    });
    write(fixture.root, other.patch, otherPatch);
    recorded(fixture.root, [fixture.fault, other]);
    return { ...fixture, base: headOf(fixture.root) };
  }

  test("names only the faults whose patch touches a file changed since the base", async () => {
    const { root, id, base } = twoFaults();
    commit(root, "reword the refusal", {
      "src/limit.ts": guarded.replace("must be", "has to be"),
    });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("names a fault whose own patch changed, though no patched file did", async () => {
    const { root, base } = twoFaults();
    commit(root, "replant other", { [other.patch]: `${otherPatch}\n` });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([other.id]);
  });

  test("names no fault when the changed files are ones no patch touches", async () => {
    const { root, base } = twoFaults();
    commit(root, "notes", { "README.md": "notes\n" });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([]);
  });

  test("names a fault whose test file changed, though its patched file did not", async () => {
    const { root, id, base } = twoFaults();
    commit(root, "weaken the refusal test", {
      "tests/limit.test.ts": limitTests.replace(
        "L.refuses NaN twice",
        "L.refuses NaN again",
      ),
    });
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id, other.id]);
  });

  test("names a fault whose patched file was renamed away", async () => {
    const { root, id, base } = twoFaults();
    git(root, "mv", "src/limit.ts", "src/bound.ts");
    git(root, "commit", "--quiet", "-m", "rename limit");
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("names a fault whose record changed, though no file it names did", async () => {
    const { root, id, fault, base } = twoFaults();
    recorded(root, [{ ...fault, title: "^L\\.weak " }, other]);
    const { result } = await isolated(() => faultsTouchedSince(root, base));
    expect(result).toEqual([id]);
  });

  test("refuses a base git cannot resolve, naming it", async () => {
    const { root } = twoFaults();
    expect(
      await rejection(isolated(() => faultsTouchedSince(root, "no-such-base"))),
    ).toBe(
      "no-such-base is not a commit in this repository. Repair: pass a commit or branch, such as origin/main.",
    );
  });
});
