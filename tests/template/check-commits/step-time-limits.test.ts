import { describe, expect, test } from "bun:test";
import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { stepLimitMilliseconds } from "../../../scripts/process-runner.ts";
import {
  checkCommitsFixture,
  manifest,
  markers,
  repository,
} from "../../support/check-commits-fixture.ts";
import {
  commitIn,
  fixtureGitMilliseconds,
  initRepository,
  worktreeLines,
} from "../../support/git-fixture.ts";
import { jobOf } from "../../support/workflows.ts";
import {
  doctorProject,
  exited,
  gitWrapper,
  hangIgnoringTerm,
  reapBound,
  reapRecorded,
  recordedProcesses,
  runDoctor,
  sleepWithChild,
} from "./step-time-limits-fixture.ts";

const { folder, repositoryAt, checkCommits } = checkCommitsFixture();

const stepSeconds = 1;
const graceMilliseconds = 2_000;
const toleranceMilliseconds = 5_000;
const stepBound =
  stepSeconds * 1000 + graceMilliseconds + toleranceMilliseconds;
const childRunBound = stepBound + 2_000;
const defaultChildBound = 20_000;
const psBound = 10_000;
const processGroupBound = 2_000;
const reapRecordedBound = 4 * processGroupBound;
const timeoutMargin = 5_000;
const hangCheckCommitsTimeout =
  11 * fixtureGitMilliseconds +
  childRunBound +
  psBound +
  2 * reapBound +
  reapRecordedBound +
  timeoutMargin;
const hangGitTimeout =
  10 * fixtureGitMilliseconds +
  childRunBound +
  psBound +
  2 * reapBound +
  reapRecordedBound +
  timeoutMargin;
const hangDoctorTimeout =
  childRunBound + psBound + 2 * reapBound + reapRecordedBound + timeoutMargin;
const hookEnvCheckCommitsTimeout =
  11 * fixtureGitMilliseconds + childRunBound + psBound + timeoutMargin;
const hookEnvDoctorTimeout = childRunBound + psBound + timeoutMargin;
const limitCheckCommitsTimeout =
  10 * fixtureGitMilliseconds +
  2 * (defaultChildBound + psBound) +
  timeoutMargin;
const limitDoctorTimeout = 2 * (defaultChildBound + psBound) + timeoutMargin;
const maxStepLimitSeconds = 2_147_483;

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
    hangCheckCommitsTimeout,
  );

  test(
    "TL.b a check:commits git call that ignores SIGTERM and has a child fails within its limit, kills both, and prints a FAIL line with Repair",
    async () => {
      const scratch = folder("step-limit-git-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const { root, base, commit } = repositoryAt();
      commit("green commit behind hung git", { "a.txt": "a" });
      const pathWithWrapper = gitWrapper(
        scratch,
        hangIgnoringTerm(ledger, pids),
      );
      const started = performance.now();

      try {
        const run = await checkCommits(
          root,
          [base.sha],
          {
            CHECK_COMMITS_SINCE: base.sha,
            CHECK_COMMITS_STEP_SECONDS: String(stepSeconds),
            PATH: pathWithWrapper,
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
    hangGitTimeout,
  );

  test(
    "TL.c a doctor fallow step that ignores SIGTERM and has a child fails within its limit, kills both, and prints a FAIL line with Repair",
    async () => {
      const scratch = folder("step-limit-doctor-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const root = doctorProject(
        folder,
        `#!/bin/sh\n${hangIgnoringTerm(ledger, pids)}\n`,
      );
      const started = performance.now();

      try {
        const run = await runDoctor(
          root,
          { DOCTOR_STEP_SECONDS: String(stepSeconds) },
          { boundMilliseconds: childRunBound },
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
    hangDoctorTimeout,
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
    limitCheckCommitsTimeout,
  );

  test(
    "TL.e doctor refuses DOCTOR_STEP_SECONDS above 2,147,483 s and accepts 2,147,483 s",
    async () => {
      const root = doctorProject(
        folder,
        '#!/bin/sh\necho \'{"status":"pass","checks":[]}\'\n',
      );

      const refused = await runDoctor(root, {
        DOCTOR_STEP_SECONDS: String(maxStepLimitSeconds + 1),
      });
      expect(refused.exit).toBe(2);
      expect(refused.stderr).toBe(
        `DOCTOR_STEP_SECONDS is '${maxStepLimitSeconds + 1}'. Repair: set it to a positive number of seconds up to ${maxStepLimitSeconds}, or unset it for 30 s.\n`,
      );

      const admitted = await runDoctor(root, {
        DOCTOR_STEP_SECONDS: String(maxStepLimitSeconds),
      });
      expect(admitted.exit).toBe(0);
    },
    limitDoctorTimeout,
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
    hookEnvCheckCommitsTimeout,
  );

  test(
    "TL.i doctor ignores a hook-exported GIT_DIR when running fallow doctor",
    async () => {
      const root = doctorProject(
        folder,
        '#!/bin/sh\nif [ -n "$GIT_DIR" ]; then\n  echo \'{"status":"fail","checks":[{"id":"env","status":"fail","message":"GIT_DIR leaked"}]}\'\n  exit 2\nfi\necho \'{"status":"pass","checks":[]}\'\n',
      );

      const run = await runDoctor(
        root,
        { GIT_DIR: "/nonexistent" },
        { boundMilliseconds: childRunBound },
      );

      expect(run.exit).toBe(0);
      expect(run.stdout.split("\n")).toContain(
        "ok fallow: fallow doctor passes.",
      );
    },
    hookEnvDoctorTimeout,
  );

  test(
    "TL.j interrupting doctor stops fallow doctor and its child",
    async () => {
      const scratch = folder("doctor-interrupt-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const root = doctorProject(
        folder,
        `#!/bin/sh\n${sleepWithChild(ledger, pids)}\n`,
      );

      try {
        const run = await runDoctor(
          root,
          { DOCTOR_STEP_SECONDS: "30" },
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
    hangDoctorTimeout,
  );

  test(
    "TL.k a check:commits git call that obeys SIGTERM on timeout reports a FAIL timeout, not Stopped by SIGTERM",
    async () => {
      const scratch = folder("step-limit-git-term-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const { root, base, commit } = repositoryAt();
      commit("green commit behind term-obeying git", { "a.txt": "a" });
      const pathWithWrapper = gitWrapper(scratch, sleepWithChild(ledger, pids));

      try {
        const run = await checkCommits(
          root,
          [base.sha],
          {
            CHECK_COMMITS_SINCE: base.sha,
            CHECK_COMMITS_STEP_SECONDS: String(stepSeconds),
            PATH: pathWithWrapper,
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
    hangGitTimeout,
  );

  test(
    "TL.l interrupting check:commits during doctor stops fallow doctor and its child",
    async () => {
      const scratch = folder("check-commits-doctor-interrupt-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const root = doctorProject(
        folder,
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
    hangGitTimeout,
  );

  test(
    "TL.m interrupting check:commits during a git call stops the git process group",
    async () => {
      const scratch = folder("check-commits-git-interrupt-");
      const ledger = join(scratch, "ledger");
      const pids = join(scratch, "pids");
      const { root, base, commit } = repositoryAt();
      commit("green commit behind interrupted git", { "a.txt": "a" });
      const pathWithWrapper = gitWrapper(scratch, sleepWithChild(ledger, pids));

      try {
        const run = await checkCommits(
          root,
          [base.sha],
          {
            CHECK_COMMITS_SINCE: base.sha,
            CHECK_COMMITS_STEP_SECONDS: "30",
            PATH: pathWithWrapper,
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
        expect(readdirSync(run.temporary)).toEqual([]);
      } finally {
        reapRecorded(pids);
      }
    },
    hangGitTimeout,
  );
});
