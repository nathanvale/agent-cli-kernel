import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  processWatchdog,
  type SignalAt,
  spawnBounded,
} from "./support/process.ts";
import { testFolder } from "./support/test-folder.ts";

const repository = join(import.meta.dir, "..");
const folders: string[] = [];
const pidLedgers: string[] = [];
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
// Platform: A caller such as a git hook can export these, and they override `cwd`.
const repositoryLocation = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
]);
const fixtureAuthor = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const bound = 15_000;
const timeout = 20_000;
const { scripts: production } = (await Bun.file(
  join(repository, "package.json"),
).json()) as { scripts: Record<string, string> };

const unguarded = `export function limit(value: number): number {
  return value;
}
`;
const guarded = `export function limit(value: number): number {
  if (Number.isNaN(value)) throw new TypeError("limit must be a number");
  return value;
}
`;
const refusalTest = `expect(() => limit(Number.NaN)).toThrow("limit must be a number")`;
const tests = (refusal: string) => `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { limit } from "../src/limit.ts";

appendFileSync(
  process.env.FAULTS_PIDS ?? "/dev/null",
  \`\${process.pid} \${process.ppid}\\n\`,
);

test("L.refuses NaN", () => {
  ${refusal};
});
test("L.weak keeps a number", () => {
  expect(limit(1)).toBe(1);
});
test("L.red is red without the fault", () => {
  expect(limit(1)).toBe(2);
});
test("L.tools sees only the tools its own tree installs", () => {
  expect(Bun.which("fault-replay-caller-tool")).toBeNull();
});
test("L.dies by a signal nobody sent the run", () => {
  process.kill(process.pid, "SIGKILL");
});
test("L.blocks until stopped", async () => {
  appendFileSync(process.env.FAULTS_LEDGER ?? "", "started\\n");
  await new Promise(() => undefined);
}, 60_000);
test("L.traps SIGTERM and blocks", async () => {
  process.on("SIGTERM", () => {
    appendFileSync(process.env.FAULTS_LEDGER ?? "", "trapped\\n");
  });
  appendFileSync(process.env.FAULTS_LEDGER ?? "", "started\\n");
  await new Promise(() => undefined);
}, 60_000);
`;

afterAll(async () => {
  for (const ledger of pidLedgers) await release(ledger);
  for (const folder of folders) rmSync(folder, { recursive: true });
});

function folder(prefix: string): string {
  const path = testFolder(prefix);
  folders.push(path);
  return path;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...fixtureEnv(), ...fixtureAuthor },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function pidLedger(): string {
  const path = join(folder("fault-replay-pids-"), "pids");
  pidLedgers.push(path);
  return path;
}

function ledgered(ledger: string): { pid: number; parent: number }[] {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [pid = Number.NaN, parent = Number.NaN] = line
        .split(" ")
        .map(Number);
      return { pid, parent };
    });
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ESRCH") return false;
    throw error;
  }
}

function exited(pid: number, boundMilliseconds = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const gone = !running(pid);
      if (!gone && Date.now() - started < boundMilliseconds) return;
      clearInterval(poll);
      resolve(gone);
    }, 5);
  });
}

async function release(ledger: string): Promise<void> {
  for (const { pid } of ledgered(ledger)) {
    const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    if (group !== String(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
    }
    await exited(pid);
  }
}

function worktrees(root: string): string[] {
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function releaseWorktrees(root: string): void {
  for (const tree of worktrees(root))
    if (tree !== root) git(root, "worktree", "remove", "--force", tree);
}

function fixtureEnv(): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !repositoryLocation.has(name),
      ),
    ),
    ...gitEnv,
  };
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

async function faultReplay(
  root: string,
  args: readonly string[] = [],
  {
    signalAt,
    env = {},
    launcher = [],
    boundMilliseconds = bound,
    pids = pidLedger(),
  }: {
    signalAt?: SignalAt;
    env?: Readonly<Record<string, string>>;
    launcher?: readonly string[];
    boundMilliseconds?: number;
    pids?: string;
  } = {},
) {
  const temporary = folder("fault-replay-tmp-");
  try {
    const run = await spawnBounded(
      [
        ...launcher,
        process.execPath,
        "run",
        "--silent",
        "fault-replay",
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...fixtureEnv(),
          TMPDIR: temporary,
          FAULTS_PIDS: pids,
          ...env,
        },
        boundMilliseconds,
        processGroup: true,
        signalAt,
      },
    );
    return { ...run, temporary, pids, lines: run.stdout.split("\n") };
  } catch (error) {
    await release(pids);
    releaseWorktrees(root);
    throw error;
  }
}

function addFault(
  root: string,
  fix: string,
  sourcePath: string,
  testFile = "tests/limit.test.ts",
  title = "^L\\.refuses ",
) {
  return spawnBounded(
    [
      process.execPath,
      "run",
      "--silent",
      "planted-fault:add",
      fix,
      sourcePath,
      testFile,
      title,
    ],
    {
      cwd: root,
      env: fixtureEnv(),
      boundMilliseconds: bound,
      processGroup: true,
    },
  );
}

type FaultRecord = {
  id: string;
  patch: string;
  testFile: string;
  title: string;
  source: string;
};

function records(root: string): FaultRecord[] {
  return JSON.parse(
    readFileSync(join(root, "tests/planted-faults/fault-records.json"), "utf8"),
  ) as FaultRecord[];
}

async function repositoryWithFault(
  siblingTitlesById: Readonly<{ [id: string]: string }>,
) {
  const root = join(folder("fault-replay-repo-"), "repo");
  mkdirSync(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  commit(root, "base", {
    "package.json": JSON.stringify({
      name: "fixture",
      private: true,
      scripts: {
        "fault-replay": production["fault-replay"],
        "planted-fault:add": production["planted-fault:add"],
      },
    }),
    ".gitignore": "node_modules/\n",
    "scripts/planted-faults.ts": readFileSync(
      join(repository, "scripts/planted-faults.ts"),
      "utf8",
    ),
    "scripts/process-runner.ts": readFileSync(
      join(repository, "scripts/process-runner.ts"),
      "utf8",
    ),
    "src/limit.ts": unguarded,
  });
  const fix = commit(root, "fix: refuse a NaN limit", {
    "src/limit.ts": guarded,
    "tests/limit.test.ts": tests(refusalTest),
  });
  const added = await addFault(root, fix, "src/limit.ts");
  expect(added.stdout).toBe(
    `Added ${fix}-limit. Replay it: bun run fault-replay ${fix}-limit\n`,
  );
  const [killed] = records(root);
  if (killed === undefined)
    throw new Error("planted-fault:add wrote no record.");
  const siblings = Object.entries(siblingTitlesById).map(([id, title]) => ({
    ...killed,
    id,
    title,
  }));
  write(
    root,
    "tests/planted-faults/fault-records.json",
    `${JSON.stringify([killed, ...siblings], null, 2)}\n`,
  );
  git(root, "add", "--", "tests/planted-faults");
  git(root, "commit", "--quiet", "-m", "record the faults");
  return { root, fix, id: `${fix}-limit`, killed };
}

function verdicts(lines: readonly string[]): string[] {
  return lines.flatMap((line) =>
    /^(KILLED|SURVIVED|STALE|BROKEN|TIMEOUT) /.test(line)
      ? [line.split(" ", 2).join(" ")]
      : [],
  );
}

function lineOf(lines: readonly string[], start: string): string {
  const line = lines.find((each) => each.startsWith(start));
  if (line === undefined) throw new Error(`No line starts with ${start}.`);
  return line;
}

const stepSeconds = 3;
const hangBound = 30_000;
const forcedBound = 10_000;

function hangLedger() {
  const ledger = join(folder("fault-replay-hang-"), "ledger");
  appendFileSync(ledger, "");
  return { ledger, lines: () => readFileSync(ledger, "utf8").split("\n") };
}

function expectOneTestProcessGone(pids: string): void {
  const [only, ...more] = ledgered(pids);
  expect(more).toEqual([]);
  expect(only !== undefined && running(only.pid)).toBe(false);
}

function expectNoLeftovers(root: string, temporary: string): void {
  expect(worktrees(root)).toEqual([root]);
  expect(readdirSync(temporary)).toEqual([]);
}

describe("bun run fault-replay", () => {
  test(
    "FR.a planted-fault:add stores the fix's reverse hunk, and the fault is KILLED with exit 0",
    async () => {
      const { root, fix, id, killed } = await repositoryWithFault({});
      expect(killed).toEqual({
        id,
        patch: `tests/planted-faults/patches/${id}.patch`,
        testFile: "tests/limit.test.ts",
        title: "^L\\.refuses ",
        source: `${fix} fix: refuse a NaN limit`,
      });
      expect(readFileSync(join(root, killed.patch), "utf8")).toBe(
        git(root, "diff", "HEAD~1", "HEAD~2", "--", "src/limit.ts"),
      );
      const run = await faultReplay(root);
      expect(verdicts(run.lines)).toEqual([`KILLED ${id}`]);
      expect(lineOf(run.lines, "KILLED")).toMatch(
        new RegExp(`^KILLED ${id} in [\\d.]+ s\\. Failed: L\\.refuses NaN$`),
      );
      expect(lineOf(run.lines, "1 of 1 planted faults KILLED in ")).toMatch(
        /s per fault, with Bun /,
      );
      expect(run.exit).toBe(0);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.b a fault the named test misses is SURVIVED, named with its rerun, and exits 1",
    async () => {
      const { root, id } = await repositoryWithFault({
        weak: "^L\\.weak ",
      });
      const run = await faultReplay(root);
      expect(verdicts(run.lines)).toEqual([`KILLED ${id}`, "SURVIVED weak"]);
      expect(run.lines).toContain(
        "Repair: change tests/limit.test.ts so that test fails with the patch applied. Done when bun run fault-replay weak passes.",
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.c a patch that no longer applies is STALE by id, and exits 1",
    async () => {
      const { root, id } = await repositoryWithFault({});
      commit(root, "reword the refusal", {
        "src/limit.ts": guarded.replace("must be", "has to be"),
        "tests/limit.test.ts": tests(
          refusalTest.replace("must be", "has to be"),
        ),
      });
      const run = await faultReplay(root, [id]);
      expect(verdicts(run.lines)).toEqual([`STALE ${id}`]);
      expect(lineOf(run.lines, "STALE")).toMatch(
        new RegExp(
          `^STALE ${id} in [\\d.]+ s\\. tests/planted-faults/patches/${id}\\.patch no longer applies at this head\\.$`,
        ),
      );
      expect(run.lines).toContain(
        `Repair: plant the fault again by hand, run git diff -- src/limit.ts > tests/planted-faults/patches/${id}.patch, then undo the planted edit. Done when bun run fault-replay ${id} passes.`,
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.d a test that fails without the fault is BROKEN, not KILLED, and exits 1",
    async () => {
      const { root } = await repositoryWithFault({ red: "^L\\.red " });
      const run = await faultReplay(root, ["red"]);
      expect(verdicts(run.lines)).toEqual(["BROKEN red"]);
      expect(lineOf(run.lines, "BROKEN")).toMatch(
        /^BROKEN red in [\d.]+ s\. bun test \.\/tests\/limit\.test\.ts -t '\^L\\\.red ' fails without the patch, so the planted fault shows nothing\.$/,
      );
      expect(run.lines).toContain(
        "Repair: make that test pass without the patch. Done when bun run fault-replay red passes.",
      );
      expect(run.exit).toBe(1);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.e an id no fault record has is refused with exit 2 and runs nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      const run = await faultReplay(root, ["missing"]);
      expect(run.stderr).toBe(
        "No fault record missing in tests/planted-faults/fault-records.json. Repair: pass an id that file lists.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(2);
    },
    timeout,
  );

  test(
    "FR.t an empty list of fault records replays nothing and fails, saying the gate checks nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      write(root, "tests/planted-faults/fault-records.json", "[]\n");
      const run = await faultReplay(root, []);
      expect(run.lines).toContain(
        "tests/planted-faults/fault-records.json has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(1);
    },
    timeout,
  );

  test(
    "FR.f a replay leaves the caller's tree, index, branch and stash as they were, and sees its uncommitted edits",
    async () => {
      const { root, id } = await repositoryWithFault({});
      write(root, "notes.txt", "staged\n");
      git(root, "add", "--", "notes.txt");
      write(root, "tests/limit.test.ts", tests("expect(true).toBe(true)"));
      write(root, "untracked.txt", "untracked\n");
      const state = () =>
        [
          git(root, "status", "--porcelain=v1", "--untracked-files=all"),
          git(root, "diff"),
          git(root, "diff", "--cached"),
          git(root, "rev-parse", "HEAD"),
          git(root, "symbolic-ref", "HEAD"),
          git(root, "stash", "list"),
        ].join("\n--\n");
      const before = state();
      const run = await faultReplay(root);
      expect(verdicts(run.lines)).toEqual([`SURVIVED ${id}`]);
      expect(state()).toBe(before);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.i planted-fault:add refuses a source path the fix does not change, and writes nothing",
    async () => {
      const { root, fix } = await repositoryWithFault({});
      const before = readFileSync(
        join(root, "tests/planted-faults/fault-records.json"),
        "utf8",
      );
      const added = await addFault(root, fix, "package.json");
      expect(added.stderr).toBe(
        `${fix} does not change package.json. Repair: pass a path that git diff --name-only ${fix}^ ${fix} lists.\n`,
      );
      expect(added.exit).toBe(2);
      expect(
        readFileSync(
          join(root, "tests/planted-faults/fault-records.json"),
          "utf8",
        ),
      ).toBe(before);
      expect(readdirSync(join(root, "tests/planted-faults/patches"))).toEqual([
        `${fix}-limit.patch`,
      ]);
    },
    timeout,
  );

  for (const [field, testFile, title, refusal] of [
    [
      "an empty title",
      "tests/limit.test.ts",
      "",
      "planted-fault:add needs a non-empty string title. Repair: name the bun test -t pattern that selects the test that kills the planted fault.",
    ],
    [
      "a missing test file",
      "tests/missing.test.ts",
      "^L\\.refuses ",
      "planted-fault:add names testFile tests/missing.test.ts, which does not exist. Repair: name a test file relative to the repository root.",
    ],
  ] as const)
    test(
      `FR.m planted-fault:add refuses ${field} by name with its fix, and writes nothing`,
      async () => {
        const { root, id } = await repositoryWithFault({});
        const reworded = commit(root, "fix: reword the refusal", {
          "src/limit.ts": guarded.replace("must be", "has to be"),
          "tests/limit.test.ts": tests(
            refusalTest.replace("must be", "has to be"),
          ),
        });
        const before = readFileSync(
          join(root, "tests/planted-faults/fault-records.json"),
          "utf8",
        );
        const added = await addFault(
          root,
          reworded,
          "src/limit.ts",
          testFile,
          title,
        );
        expect(added.stderr).toBe(`${refusal}\n`);
        expect(added.exit).toBe(2);
        expect(
          readFileSync(
            join(root, "tests/planted-faults/fault-records.json"),
            "utf8",
          ),
        ).toBe(before);
        expect(readdirSync(join(root, "tests/planted-faults/patches"))).toEqual(
          [`${id}.patch`],
        );
      },
      processWatchdog(2),
    );

  test(
    "FR.j a replayed test sees only the tools its own tree installs, not the caller's node_modules/.bin",
    async () => {
      const { root } = await repositoryWithFault({
        tools: "^L\\.(refuses|tools) ",
      });
      write(root, "node_modules/.bin/fault-replay-caller-tool", "#!/bin/sh\n");
      chmodSync(
        join(root, "node_modules/.bin/fault-replay-caller-tool"),
        0o755,
      );
      const run = await faultReplay(root, ["tools"]);
      expect(verdicts(run.lines)).toEqual(["KILLED tools"]);
      expect(run.exit).toBe(0);
    },
    processWatchdog(2),
  );

  test(
    "FR.k a test killed by a signal the run did not receive gives no verdict and exits 2",
    async () => {
      const { root } = await repositoryWithFault({ dies: "^L\\.dies " });
      const run = await faultReplay(root, ["dies"]);
      expect(run.stderr).toContain(
        " was killed by SIGKILL while replaying dies, so it has no verdict.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(2);
      expectNoLeftovers(root, run.temporary);
    },
    processWatchdog(2),
  );

  for (const [signal, exit] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    test(
      `FR.g ${signal} stops the replay with exit ${exit}, no verdict, no worktree and no running test`,
      async () => {
        const { root } = await repositoryWithFault({
          blocks: "^L\\.blocks ",
        });
        const hang = hangLedger();
        const run = await faultReplay(root, ["blocks"], {
          signalAt: { ledger: hang.ledger, line: "started", signal },
          env: { FAULTS_LEDGER: hang.ledger },
        });
        expect(run.stderr).toContain(
          `Stopped by ${signal} while replaying blocks, so it has no verdict.\n`,
        );
        expect(verdicts(run.lines)).toEqual([]);
        expect(run.exit).toBe(exit);
        expectOneTestProcessGone(run.pids);
        expectNoLeftovers(root, run.temporary);
      },
      timeout,
    );

  for (const [id, title, trapped] of [
    ["blocks", "^L\\.blocks ", []],
    ["traps", "^L\\.traps ", ["trapped"]],
  ] as const)
    test(
      `FR.o a replayed test that ${id === "traps" ? "traps SIGTERM and " : ""}hangs past the step limit is TIMEOUT by id, exits 1, and leaves no process or worktree`,
      async () => {
        const { root } = await repositoryWithFault({ [id]: title });
        const hang = hangLedger();
        const run = await faultReplay(root, [id], {
          env: {
            FAULTS_LEDGER: hang.ledger,
            FAULT_REPLAY_STEP_SECONDS: String(stepSeconds),
          },
          boundMilliseconds: hangBound,
        });
        expect(verdicts(run.lines)).toEqual([`TIMEOUT ${id}`]);
        expect(lineOf(run.lines, "TIMEOUT")).toMatch(
          new RegExp(
            `^TIMEOUT ${id} in [\\d.]+ s\\. \\S+ test \\./tests/limit\\.test\\.ts -t \\^L\\\\\\.${id}  did not finish within ${stepSeconds} s, so the planted fault has no verdict\\.$`,
          ),
        );
        expect(run.lines).toContain(
          `Repair: run that step by hand to see where it hangs, or raise FAULT_REPLAY_STEP_SECONDS. Done when bun run fault-replay ${id} passes.`,
        );
        expect(run.exit).toBe(1);
        expect(hang.lines().filter((line) => line === "trapped")).toEqual([
          ...trapped,
        ]);
        expectOneTestProcessGone(run.pids);
        expectNoLeftovers(root, run.temporary);
      },
      hangBound + 10_000,
    );

  test(
    "FR.p a SIGINT to a replay whose test traps SIGTERM escalates to SIGKILL, exits 130, and leaves no process or worktree",
    async () => {
      const { root } = await repositoryWithFault({ traps: "^L\\.traps " });
      const hang = hangLedger();
      const run = await faultReplay(root, ["traps"], {
        signalAt: { ledger: hang.ledger, line: "started", signal: "SIGINT" },
        env: { FAULTS_LEDGER: hang.ledger },
        boundMilliseconds: hangBound,
      });
      expect(run.stderr).toContain(
        "Stopped by SIGINT while replaying traps, so it has no verdict.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(130);
      expect(hang.lines()).toContain("trapped");
      expectOneTestProcessGone(run.pids);
      expectNoLeftovers(root, run.temporary);
    },
    hangBound + 10_000,
  );

  test(
    "FR.r a run that outlives its test bound leaves no replay script, test process or worktree behind",
    async () => {
      const { root } = await repositoryWithFault({ blocks: "^L\\.blocks " });
      const hang = hangLedger();
      const pids = pidLedger();
      const outcome = await faultReplay(root, ["blocks"], {
        env: { FAULTS_LEDGER: hang.ledger },
        boundMilliseconds: forcedBound,
        pids,
      }).then(
        () => "exited",
        (error: unknown) => String(error),
      );
      expect(outcome).toEndWith(`did not exit within ${forcedBound} ms.`);
      expect(hang.lines()).toContain("started");
      const [test, ...more] = ledgered(pids);
      expect(more).toEqual([]);
      if (test === undefined) throw new Error("No test process was ledgered.");
      expect(await exited(test.pid)).toBe(true);
      expect(await exited(test.parent)).toBe(true);
      expect(worktrees(root)).toEqual([root]);
    },
    forcedBound + 15_000,
  );

  test(
    "FR.s a caller's GIT_DIR does not redirect the fixture's git, planted-fault:add or replay to another repository",
    async () => {
      const unrelated = join(folder("fault-replay-caller-"), "repo");
      mkdirSync(unrelated);
      git(unrelated, "init", "--quiet", "--initial-branch=main");
      commit(unrelated, "caller", { "caller.txt": "caller\n" });
      const state = () =>
        [
          git(unrelated, "log", "--format=%H %s", "--all"),
          git(unrelated, "worktree", "list", "--porcelain"),
          git(unrelated, "status", "--porcelain=v1", "--untracked-files=all"),
          git(unrelated, "config", "--local", "--list"),
        ].join("\n--\n");
      const before = state();
      process.env.GIT_DIR = join(unrelated, ".git");
      try {
        const { root, id } = await repositoryWithFault({});
        const run = await faultReplay(root);
        expect(verdicts(run.lines)).toEqual([`KILLED ${id}`]);
        expect(run.exit).toBe(0);
        expect(git(root, "log", "--format=%s")).toBe(
          "record the faults\nfix: refuse a NaN limit\nbase\n",
        );
      } finally {
        delete process.env.GIT_DIR;
      }
      expect(state()).toBe(before);
    },
    processWatchdog(3),
  );

  test(
    "FR.q a step limit that is not a positive number is refused with exit 2 and runs nothing",
    async () => {
      const { root } = await repositoryWithFault({});
      const run = await faultReplay(root, [], {
        env: { FAULT_REPLAY_STEP_SECONDS: "0" },
      });
      expect(run.stderr).toBe(
        "FAULT_REPLAY_STEP_SECONDS is '0'. Repair: set it to a positive number of seconds, or unset it for 300 s.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(2);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.l a stop that finds the step's process group holding only zombies still exits 130 (macOS answers EPERM there)",
    async () => {
      const { root, id } = await repositoryWithFault({});
      const tools = folder("fault-replay-zombie-");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      write(
        tools,
        "bin/git",
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = add ]; then
  perl -e '
    my ($replay, $shim) = @ARGV;
    if (!fork) { exit 0 }
    setpgrp(0, 0);
    select(undef, undef, undef, 0.01) while getppid() == $shim;
    kill "INT", $replay;
    select(undef, undef, undef, 2);
  ' "$PPID" "$$" &
fi
exec '${realGit}' "$@"
`,
      );
      chmodSync(join(tools, "bin/git"), 0o755);
      const run = await faultReplay(root, [], {
        env: { PATH: `${join(tools, "bin")}${delimiter}${process.env.PATH}` },
      });
      expect(run.stderr).toContain(
        `Stopped by SIGINT while replaying ${id}, so it has no verdict.\n`,
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(130);
      expectNoLeftovers(root, run.temporary);
    },
    processWatchdog(2),
  );

  test(
    "FR.n a SIGINT while git removes a record's worktree stops on that record, before the next one starts",
    async () => {
      const { root, id } = await repositoryWithFault({ next: "^L\\.refuses " });
      const tools = folder("fault-replay-remove-");
      const once = join(tools, "signalled");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      write(
        tools,
        "bin/git",
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = remove ] && [ ! -e '${once}' ]; then
  : > '${once}'
  kill -INT "$PPID"
fi
exec '${realGit}' "$@"
`,
      );
      chmodSync(join(tools, "bin/git"), 0o755);
      const run = await faultReplay(root, [], {
        env: { PATH: `${join(tools, "bin")}${delimiter}${process.env.PATH}` },
      });
      expect(run.stderr).toContain(
        `Stopped by SIGINT while replaying ${id}, so it has no verdict.\n`,
      );
      expect(run.stderr).not.toContain("while replaying next");
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(130);
      expectNoLeftovers(root, run.temporary);
    },
    processWatchdog(2),
  );

  test(
    "FR.h a terminal's group SIGINT while git removes the worktree still removes it, and exits 130",
    async () => {
      const { root } = await repositoryWithFault({});
      const tools = folder("fault-replay-group-");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      write(
        tools,
        "bin/git",
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = remove ]; then
  kill -INT -"$(ps -o pgid= -p "$PPID" | tr -d ' ')"
fi
exec '${realGit}' "$@"
`,
      );
      chmodSync(join(tools, "bin/git"), 0o755);
      write(
        tools,
        "own-group.ts",
        `const child = Bun.spawn(process.argv.slice(2), {
  detached: true,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await child.exited);
`,
      );
      const run = await faultReplay(root, [], {
        launcher: [process.execPath, join(tools, "own-group.ts")],
        env: { PATH: `${join(tools, "bin")}${delimiter}${process.env.PATH}` },
      });
      expect(run.exit).toBe(130);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );
});
