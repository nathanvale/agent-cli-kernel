import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { stepLimitMilliseconds } from "../../../scripts/process-runner.ts";
import {
  checkCommitsFixture,
  manifest,
  markers,
  repository,
} from "../../support/check-commits-fixture.ts";
import {
  commitIn,
  gitEnv,
  inherited,
  initRepository,
  worktreeLines,
} from "../../support/git-fixture.ts";
import {
  processGroupOf,
  processWatchdog,
  spawnBounded,
} from "../../support/process.ts";
import { signalGroupIfPresent, signalIfPresent } from "../../support/signal.ts";
import { jobOf } from "../../support/workflows.ts";

const { folder, repositoryAt, checkCommits } = checkCommitsFixture();

const stepSeconds = 1;
const graceMilliseconds = 2_000;
const toleranceMilliseconds = 5_000;
const stepBound =
  stepSeconds * 1000 + graceMilliseconds + toleranceMilliseconds;
const childRunBound = stepBound + 2_000;
const reapBound = 5_000;
const psBound = 10_000;
const fixtureGitBound = 4_000;
const timeoutMargin = 5_000;
const hangTestTimeout =
  4 * fixtureGitBound + childRunBound + psBound + 2 * reapBound + timeoutMargin;
const maxStepLimitSeconds = 2_147_483;

const doctorSources = [
  "scripts/doctor.ts",
  "scripts/process-runner.ts",
  "src/toolchain-resolution.ts",
];

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ESRCH") return false;
    throw error;
  }
}

// Platform: an orphan is reaped by init or launchd, not by this process, so
// it can answer signal 0 for a while after it was killed.
function exited(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const gone = !running(pid);
      if (!gone && Date.now() - started < reapBound) return;
      clearInterval(poll);
      resolve(gone);
    }, 5);
  });
}

const ownProcessGroup = processGroupOf(process.pid);

function recordedProcesses(path: string): {
  readonly group: number | undefined;
  readonly pids: readonly number[];
} {
  if (!existsSync(path)) return { group: undefined, pids: [] };
  const numbers = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const [group, ...pids] = numbers;
  return { group, pids };
}

function reapRecorded(path: string): void {
  const { group, pids } = recordedProcesses(path);
  if (group === undefined || group === ownProcessGroup) return;
  const stillInGroup = pids.filter(
    (pid) => pid !== process.pid && processGroupOf(pid) === group,
  );
  if (stillInGroup.length === 0) return;
  signalGroupIfPresent(group, "SIGKILL");
  for (const pid of stillInGroup)
    if (processGroupOf(pid) === group) signalIfPresent(pid, "SIGKILL");
}

function sleepScript(
  ledger: string,
  pids: string,
  ignoreTerm: boolean,
): string {
  const trap = ignoreTerm ? "trap '' TERM; " : "";
  return [
    ...(ignoreTerm ? ["trap '' TERM"] : []),
    `(${trap}exec sleep 300) &`,
    "child=$!",
    "pgid=$(perl -e 'print getpgrp(0)')",
    `printf '%s\\n%s\\n%s\\n' "$pgid" "$$" "$child" > '${pids}'`,
    `echo started >> '${ledger}'`,
    "wait",
  ].join("\n");
}

function hangIgnoringTerm(ledger: string, pids: string): string {
  return sleepScript(ledger, pids, true);
}

function sleepWithChild(ledger: string, pids: string): string {
  return sleepScript(ledger, pids, false);
}

function writeFile(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function doctorProject(fallowScript: string): string {
  const root = folder("doctor-limit-");
  for (const path of doctorSources) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ packageManager: `bun@${Bun.version}` }),
    "node_modules/typescript-eslint/package.json":
      '{"name":"typescript-eslint","main":"index.js"}',
    "node_modules/typescript-eslint/index.js": "module.exports = {};",
    "node_modules/typescript/package.json":
      '{"name":"typescript","version":"6.0.2","main":"index.js"}',
    "node_modules/typescript/index.js":
      'module.exports = { version: "6.0.2" };',
    "node_modules/@typescript/native/package.json": '{"version":"7.1.0-beta"}',
    "node_modules/fallow-type-aware/package.json":
      '{"name":"fallow-type-aware","version":"3.43.2"}',
    "node_modules/fallow-type-aware/node_modules/typescript/package.json":
      '{"version":"7.0.2"}',
    "node_modules/.bin/tsc": "#!/bin/sh\necho 'Version 7.1.0-beta'\n",
    "node_modules/.bin/fallow": fallowScript,
  };
  for (const [path, content] of Object.entries(files))
    writeFile(root, path, content);
  chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
  chmodSync(join(root, "node_modules/.bin/fallow"), 0o755);
  return root;
}

describe("step time limits", () => {
  test(
    "TL.a a check:commits step that ignores SIGTERM and has a child fails within its limit, kills both, and prints a FAIL line with Repair",
    async () => {
      const scratch = folder("step-limit-check-commits-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const { root, base, commit } = repositoryAt({
        scripts: {
          ...markers,
          typecheck: `test ! -e hang || {\n${hangIgnoringTerm(ledger, pids)}\n}`,
        },
      });
      const hung = commit("hang typecheck", { hang: "" });
      const started = performance.now();

      try {
        const run = await checkCommits(
          root,
          [base.sha],
          {
            CHECK_COMMITS_SINCE: base.sha,
            CHECK_COMMITS_STEP_SECONDS: String(stepSeconds),
          },
          { boundMilliseconds: childRunBound },
        );
        const elapsed = performance.now() - started;

        expect(run.exit).toBe(2);
        expect(elapsed).toBeLessThan(stepBound);
        expect(readFileSync(ledger, "utf8").split("\n")).toContain("started");
        expect(run.stderr).toContain(
          `FAIL check:commits: bun run typecheck did not finish within ${stepSeconds} s while checking ${hung.short}, so it has no verdict. Repair: run bun run typecheck by hand to see where it hangs, or raise CHECK_COMMITS_STEP_SECONDS.`,
        );
        const { pids: both } = recordedProcesses(pids);
        expect(both).toHaveLength(2);
        for (const pid of both) expect(await exited(pid)).toBe(true);
        expect(worktreeLines(root)).toHaveLength(1);
        expect(readdirSync(run.temporary)).toEqual([]);
      } finally {
        reapRecorded(pids);
      }
    },
    hangTestTimeout,
  );

  test(
    "TL.b a check:commits git call that ignores SIGTERM and has a child fails within its limit, kills both, and prints a FAIL line with Repair",
    async () => {
      const scratch = folder("step-limit-git-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const bin = join(scratch, "bin");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      const { root, base, commit } = repositoryAt();
      commit("green commit behind hung git", { "a.txt": "a" });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh
if [ "$1 $2" = "worktree add" ]; then
  ${hangIgnoringTerm(ledger, pids)}
fi
exec '${realGit}' "$@"
`,
        { mode: 0o755 },
      );
      const started = performance.now();

      try {
        const run = await checkCommits(
          root,
          [base.sha],
          {
            CHECK_COMMITS_SINCE: base.sha,
            CHECK_COMMITS_STEP_SECONDS: String(stepSeconds),
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          },
          { boundMilliseconds: childRunBound },
        );
        const elapsed = performance.now() - started;

        expect(run.exit).toBe(2);
        expect(elapsed).toBeLessThan(stepBound);
        expect(readFileSync(ledger, "utf8").split("\n")).toContain("started");
        expect(run.stderr).toMatch(
          new RegExp(
            `FAIL check:commits: git worktree add --detach --quiet .* did not finish within ${stepSeconds} s\\. Repair: run git worktree add --detach --quiet .* by hand in .* to see where it hangs, or raise CHECK_COMMITS_STEP_SECONDS\\.`,
          ),
        );
        const { pids: both } = recordedProcesses(pids);
        expect(both).toHaveLength(2);
        for (const pid of both) expect(await exited(pid)).toBe(true);
        expect(readdirSync(run.temporary)).toEqual([]);
      } finally {
        reapRecorded(pids);
      }
    },
    hangTestTimeout,
  );

  test(
    "TL.c a doctor fallow step that ignores SIGTERM and has a child fails within its limit, kills both, and prints a FAIL line with Repair",
    async () => {
      const scratch = folder("step-limit-doctor-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const root = doctorProject(
        `#!/bin/sh\n${hangIgnoringTerm(ledger, pids)}\n`,
      );
      const started = performance.now();

      try {
        const run = await spawnBounded(
          [process.execPath, join(root, "scripts/doctor.ts")],
          {
            cwd: root,
            env: {
              ...inherited(),
              ...gitEnv,
              DOCTOR_STEP_SECONDS: String(stepSeconds),
            },
            boundMilliseconds: childRunBound,
          },
        );
        const elapsed = performance.now() - started;

        expect(run.exit).toBe(1);
        expect(elapsed).toBeLessThan(stepBound);
        expect(readFileSync(ledger, "utf8").split("\n")).toContain("started");
        expect(run.stdout.split("\n")).toContain(
          `FAIL fallow: fallow doctor did not finish within ${stepSeconds} s. Repair: run node_modules/.bin/fallow doctor to see where it hangs, or raise DOCTOR_STEP_SECONDS.`,
        );
        expect(run.stdout.split("\n")).toContain(
          "Done when bun run doctor passes.",
        );
        const { pids: both } = recordedProcesses(pids);
        expect(both).toHaveLength(2);
        for (const pid of both) expect(await exited(pid)).toBe(true);
      } finally {
        reapRecorded(pids);
      }
    },
    hangTestTimeout,
  );

  test(
    "TL.d check:commits refuses CHECK_COMMITS_STEP_SECONDS above 2,147,483 s and accepts 2,147,483 s",
    async () => {
      const { root, base, commit } = repositoryAt();
      commit("green commit", { "a.txt": "a" });

      const refused = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
        CHECK_COMMITS_STEP_SECONDS: String(maxStepLimitSeconds + 1),
      });
      expect(refused.exit).toBe(2);
      expect(refused.stderr.split("\n")).toContain(
        `CHECK_COMMITS_STEP_SECONDS is '${maxStepLimitSeconds + 1}'. Repair: set it to a positive number of seconds up to ${maxStepLimitSeconds}, or unset it for 300 s.`,
      );

      const admitted = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
        CHECK_COMMITS_STEP_SECONDS: String(maxStepLimitSeconds),
      });
      expect(admitted.exit).toBe(0);
    },
    processWatchdog(2),
  );

  test(
    "TL.e doctor refuses DOCTOR_STEP_SECONDS above 2,147,483 s and accepts 2,147,483 s",
    async () => {
      const root = doctorProject(
        '#!/bin/sh\necho \'{"status":"pass","checks":[]}\'\n',
      );

      const refused = await spawnBounded(
        [process.execPath, join(root, "scripts/doctor.ts")],
        {
          cwd: root,
          env: {
            ...inherited(),
            ...gitEnv,
            DOCTOR_STEP_SECONDS: String(maxStepLimitSeconds + 1),
          },
        },
      );
      expect(refused.exit).toBe(2);
      expect(refused.stderr).toBe(
        `DOCTOR_STEP_SECONDS is '${maxStepLimitSeconds + 1}'. Repair: set it to a positive number of seconds up to ${maxStepLimitSeconds}, or unset it for 30 s.\n`,
      );

      const admitted = await spawnBounded(
        [process.execPath, join(root, "scripts/doctor.ts")],
        {
          cwd: root,
          env: {
            ...inherited(),
            ...gitEnv,
            DOCTOR_STEP_SECONDS: String(maxStepLimitSeconds),
          },
        },
      );
      expect(admitted.exit).toBe(0);
    },
    processWatchdog(2),
  );

  test("TL.f the CI commits-shard job sets a timeout-minutes", () => {
    const shard = jobOf("ci.yml", "commits-shard");

    expect(shard["timeout-minutes"]).toBe(15);
  });

  test("TL.g stepLimitMilliseconds validates bounds, defaults, ignores inherited properties, and rejects values above 2,147,483 s", () => {
    expect(stepLimitMilliseconds({}, "STEP_SECONDS", 300)).toBe(300_000);
    expect(
      stepLimitMilliseconds({ STEP_SECONDS: "" }, "STEP_SECONDS", 30),
    ).toBe(30_000);
    const inheritedEnv = Object.create({ STEP_SECONDS: "1" }) as Record<
      string,
      string | undefined
    >;
    expect(stepLimitMilliseconds(inheritedEnv, "STEP_SECONDS", 300)).toBe(
      300_000,
    );
    expect(
      stepLimitMilliseconds(
        { STEP_SECONDS: String(maxStepLimitSeconds) },
        "STEP_SECONDS",
        300,
      ),
    ).toBe(maxStepLimitSeconds * 1000);

    for (const bad of [
      "0",
      "-1",
      "NaN",
      "Infinity",
      "abc",
      "2147483.001",
      "2147484",
    ])
      expect(() =>
        stepLimitMilliseconds({ STEP_SECONDS: bad }, "STEP_SECONDS", 300),
      ).toThrow(
        `STEP_SECONDS is '${bad}'. Repair: set it to a positive number of seconds up to ${maxStepLimitSeconds}, or unset it for 300 s.`,
      );
  });

  test(
    "TL.h check:commits ignores a hook-exported GIT_DIR when running git",
    async () => {
      const { root, base, commit } = repositoryAt();
      commit("green commit under hook GIT_DIR", { "a.txt": "a" });

      const run = await checkCommits(
        root,
        [base.sha],
        {
          CHECK_COMMITS_SINCE: base.sha,
          GIT_DIR: "/nonexistent",
        },
        { boundMilliseconds: childRunBound },
      );

      expect(run.exit).toBe(0);
      expect(worktreeLines(root)).toHaveLength(1);
      expect(readdirSync(run.temporary)).toEqual([]);
    },
    hangTestTimeout,
  );

  test(
    "TL.i doctor ignores a hook-exported GIT_DIR when running fallow doctor",
    async () => {
      const root = doctorProject(
        '#!/bin/sh\nif [ -n "$GIT_DIR" ]; then\n  echo \'{"status":"fail","checks":[{"id":"env","status":"fail","message":"GIT_DIR leaked"}]}\'\n  exit 2\nfi\necho \'{"status":"pass","checks":[]}\'\n',
      );

      const run = await spawnBounded(
        [process.execPath, join(root, "scripts/doctor.ts")],
        {
          cwd: root,
          env: {
            ...inherited(),
            ...gitEnv,
            GIT_DIR: "/nonexistent",
          },
          boundMilliseconds: childRunBound,
        },
      );

      expect(run.exit).toBe(0);
      expect(run.stdout.split("\n")).toContain(
        "ok fallow: fallow doctor passes.",
      );
    },
    hangTestTimeout,
  );

  test(
    "TL.j interrupting doctor stops fallow doctor and its child",
    async () => {
      const scratch = folder("doctor-interrupt-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const root = doctorProject(
        `#!/bin/sh\n${sleepWithChild(ledger, pids)}\n`,
      );

      try {
        const run = await spawnBounded(
          [process.execPath, join(root, "scripts/doctor.ts")],
          {
            cwd: root,
            env: {
              ...inherited(),
              ...gitEnv,
              DOCTOR_STEP_SECONDS: "30",
            },
            boundMilliseconds: childRunBound,
            signalAt: { ledger, line: "started", signal: "SIGTERM" },
          },
        );

        expect(run.exit).toBe(128 + constants.signals.SIGTERM);
        const { pids: both } = recordedProcesses(pids);
        expect(both).toHaveLength(2);
        for (const pid of both) expect(await exited(pid)).toBe(true);
      } finally {
        reapRecorded(pids);
      }
    },
    hangTestTimeout,
  );

  test(
    "TL.k a check:commits git call that obeys SIGTERM on timeout reports a FAIL timeout, not Stopped by SIGTERM",
    async () => {
      const scratch = folder("step-limit-git-term-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const bin = join(scratch, "bin");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      const { root, base, commit } = repositoryAt();
      commit("green commit behind term-obeying git", { "a.txt": "a" });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh
if [ "$1 $2" = "worktree add" ]; then
  ${sleepWithChild(ledger, pids)}
fi
exec '${realGit}' "$@"
`,
        { mode: 0o755 },
      );

      try {
        const run = await checkCommits(
          root,
          [base.sha],
          {
            CHECK_COMMITS_SINCE: base.sha,
            CHECK_COMMITS_STEP_SECONDS: String(stepSeconds),
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          },
          { boundMilliseconds: childRunBound },
        );

        expect(run.exit).toBe(2);
        expect(run.stderr).toContain("FAIL check:commits: git worktree add");
        expect(run.stderr).not.toContain("Stopped by SIGTERM");
        const { pids: both } = recordedProcesses(pids);
        expect(both).toHaveLength(2);
        for (const pid of both) expect(await exited(pid)).toBe(true);
      } finally {
        reapRecorded(pids);
      }
    },
    hangTestTimeout,
  );

  test(
    "TL.l interrupting check:commits during doctor stops fallow doctor and its child",
    async () => {
      const scratch = folder("check-commits-doctor-interrupt-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const root = doctorProject(
        `#!/bin/sh\n${sleepWithChild(ledger, pids)}\n`,
      );
      for (const path of [
        "scripts/check-commits.ts",
        "scripts/repository.ts",
        "repository.json",
      ])
        copyFileSync(join(repository, path), join(root, path));
      initRepository(root);
      const base = commitIn(root, "base", {
        ".gitignore": "node_modules\n",
        "package.json": manifest(Bun.version, markers),
      });
      commitIn(root, "green commit", { "a.txt": "a" });

      try {
        const run = await checkCommits(
          root,
          [base.sha],
          {
            CHECK_COMMITS_SINCE: base.sha,
            DOCTOR_STEP_SECONDS: "30",
          },
          {
            boundMilliseconds: childRunBound,
            signalAt: { ledger, line: "started", signal: "SIGTERM" },
          },
        );

        expect(run.exit).toBe(128 + constants.signals.SIGTERM);
        const { pids: both } = recordedProcesses(pids);
        expect(both).toHaveLength(2);
        for (const pid of both) expect(await exited(pid)).toBe(true);
      } finally {
        reapRecorded(pids);
      }
    },
    hangTestTimeout,
  );
});
