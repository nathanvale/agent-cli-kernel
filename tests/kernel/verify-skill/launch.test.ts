import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  folderTaken,
  gitFacts,
  pinnedCommitOf,
  workTreeAbove,
} from "../../../skills/verify-cli/helper/launch.ts";
import {
  causeOf,
  field,
  helper,
  lsTree,
  parsed,
  pinnedCommit,
  readOnlyScenario,
  releaseWorlds,
  runFolder,
  scenarioFile,
  watchdog,
  world,
  writePackage,
} from "./harness.ts";
import {
  commitIn,
  git,
  gitResult,
  initRepository,
} from "../../support/git-fixture.ts";

afterAll(releaseWorlds);

function message(ran: { readonly stdout: string }): unknown {
  return field(JSON.parse(ran.stdout), "message");
}

describe("launch", () => {
  test(
    "launch makes a verification run bound to one target",
    async () => {
      const at = world();
      expect(workTreeAbove(at.folder)).toBeUndefined();
      const run = runFolder(at, "r1");
      const ran = await helper(at, ["launch", run, at.example]);
      expect({ exit: ran.exit, cause: causeOf(ran) }).toEqual({
        exit: 0,
        cause: "SUCCESS_COMPLETED",
      });
      expect(lsTree(run).filter((path) => !path.startsWith("state/"))).toEqual([
        "evidence",
        "evidence/index.jsonl",
        "scratch",
        "state",
      ]);
      const rows = readFileSync(join(run, "evidence", "index.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "");
      expect(rows.map((line) => parsed(line))).toEqual([
        {
          schema: "verify-index/1",
          row: "run",
          repository: at.repo,
          target: "src/cli.ts",
          pinnedCommit,
          bun: Bun.version,
          platform: `${process.platform} ${process.arch}`,
          headCommit: null,
          uncommittedPaths: null,
        },
      ]);
    },
    watchdog(1),
  );

  test(
    "launch refuses a folder that holds something",
    async () => {
      const at = world();
      const run = runFolder(at, "taken");
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, "kept.txt"), "mine");
      const ran = await helper(at, ["launch", run, at.example]);
      expect({
        exit: ran.exit,
        cause: causeOf(ran),
        message: message(ran),
      }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_EXISTS",
        message: `${run} is not a new or empty folder.`,
      });
      expect(lsTree(run)).toEqual(["kept.txt"]);
      const empty = runFolder(at, "empty");
      mkdirSync(empty, { recursive: true });
      expect(causeOf(await helper(at, ["launch", empty, at.example]))).toBe(
        "SUCCESS_COMPLETED",
      );
    },
    watchdog(2),
  );

  test(
    "launch refuses a folder inside a work tree",
    async () => {
      const at = world();
      mkdirSync(join(at.folder, "runs", ".git"), { recursive: true });
      const run = runFolder(at, "r1");
      const ran = await helper(at, ["launch", run, at.example]);
      expect({
        exit: ran.exit,
        cause: causeOf(ran),
        message: message(ran),
      }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_RUN_IN_WORK_TREE",
        message: `${run} is inside the git work tree at ${join(at.folder, "runs")}.`,
      });
      expect(lsTree(join(at.folder, "runs"))).toEqual([".git"]);
    },
    watchdog(1),
  );

  test(
    "launch refuses a target with no Pin",
    async () => {
      const at = world();
      writePackage(at.repo, { dependencies: { "agent-cli-kernel": "main" } });
      const run = runFolder(at, "r1");
      const ran = await helper(at, ["launch", run, at.example]);
      expect({
        exit: ran.exit,
        cause: causeOf(ran),
        message: message(ran),
      }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_NO_PIN",
        message: `${join(at.repo, "package.json")} has no kernel pin: its agent-cli-kernel dependency names no full commit.`,
      });
      expect(lsTree(run)).toEqual([]);
    },
    watchdog(1),
  );

  test(
    "launch refuses a target that does not exist, and makes nothing",
    async () => {
      const at = world();
      const run = runFolder(at, "r1");
      const ran = await helper(at, ["launch", run, join(at.repo, "gone.ts")]);
      expect({ exit: ran.exit, cause: causeOf(ran) }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_TARGET_MISSING",
      });
      expect(lsTree(run)).toEqual([]);
    },
    watchdog(1),
  );

  test(
    "launch records no git facts without git",
    async () => {
      const at = world();
      const empty = join(at.folder, "empty-path");
      mkdirSync(empty);
      const run = runFolder(at, "r1");
      const ran = await helper(at, ["launch", run, at.example], {
        ...at.env,
        PATH: empty,
      });
      expect(field(ran.result, "data")).toMatchObject({
        headCommit: null,
        uncommittedPaths: null,
      });
    },
    watchdog(1),
  );

  test(
    "launch refuses a git failure it cannot read",
    async () => {
      const at = world();
      const stubs = join(at.folder, "stub-git");
      mkdirSync(stubs);
      writeFileSync(
        join(stubs, "git"),
        "#!/bin/sh\necho 'fatal: the stub git refuses to answer' >&2\nexit 128\n",
      );
      chmodSync(join(stubs, "git"), 0o755);
      const run = runFolder(at, "r1");
      const ran = await helper(at, ["launch", run, at.example], {
        ...at.env,
        PATH: stubs,
      });
      expect({
        exit: ran.exit,
        cause: causeOf(ran),
        message: message(ran),
      }).toEqual({
        exit: 3,
        cause: "DOMAIN_VERIFY_GIT_FAILED",
        message:
          "git rev-parse HEAD exited 128: fatal: the stub git refuses to answer",
      });
      expect(lsTree(run)).toEqual([]);
    },
    watchdog(1),
  );

  for (const name of ["drive", "report", "cleanup", "pending"] as const)
    test(
      `a command on an unlaunched folder is refused: ${name}`,
      async () => {
        const at = world();
        const run = runFolder(at, "never");
        const argv =
          name === "drive"
            ? [name, run, scenarioFile(at, readOnlyScenario)]
            : [name, run];
        const ran = await helper(at, argv);
        expect({
          exit: ran.exit,
          cause: causeOf(ran),
          repair: field(ran.result, "repairAction"),
        }).toEqual({
          exit: 3,
          cause: "DOMAIN_VERIFY_RUN_MISSING",
          repair:
            "Run launch with a new folder and the target, then try again.",
        });
        expect(lsTree(run)).toEqual([]);
      },
      watchdog(1),
    );
});

describe("what launch checks before it makes anything", () => {
  test("a folder is taken when it is a file or holds an entry, and free when missing or empty", () => {
    const at = world();
    const folder = join(at.folder, "probe");
    expect(folderTaken(folder)).toBe(false);
    mkdirSync(folder);
    expect(folderTaken(folder)).toBe(false);
    writeFileSync(join(folder, ".hidden"), "");
    expect(folderTaken(folder)).toBe(true);
    expect(folderTaken(join(folder, ".hidden"))).toBe(true);
  });

  test("a work tree is found by a .git entry in the folder or any folder above it", () => {
    const at = world();
    const deep = join(at.folder, "a", "b", "c");
    expect(workTreeAbove(deep)).toBeUndefined();
    writeFileSync(join(at.folder, ".git"), "gitdir: elsewhere\n");
    expect(workTreeAbove(deep)).toBe(at.folder);
  });

  test("the pinned commit is the full commit the kernel dependency names, and an unreadable package.json keeps its reason", () => {
    const at = world();
    expect(pinnedCommitOf(at.repo)).toEqual({
      kind: "pinned",
      commit: pinnedCommit,
    });
    writePackage(at.repo, {
      dependencies: {
        "agent-cli-kernel": `github:x/y#${pinnedCommit.slice(0, 39)}`,
      },
    });
    expect(pinnedCommitOf(at.repo)).toEqual({
      kind: "unpinned",
      reason: `${join(at.repo, "package.json")} has no kernel pin: its agent-cli-kernel dependency names no full commit.`,
    });
    expect(pinnedCommitOf(join(at.folder, "nowhere"))).toEqual({
      kind: "unpinned",
      reason: `${join(at.folder, "nowhere", "package.json")} is missing`,
    });
    writeFileSync(join(at.repo, "package.json"), "{ not json");
    const unreadable = pinnedCommitOf(at.repo);
    expect(unreadable.kind).toBe("unpinned");
    expect(unreadable.kind === "unpinned" ? unreadable.reason : "").toStartWith(
      `${join(at.repo, "package.json")} is not JSON: `,
    );
  });

  test("the count of uncommitted paths holds untracked files", async () => {
    const at = world();
    const root = join(at.folder, "tracked");
    initRepository(root);
    commitIn(root, "first", { "a.txt": "a\n" });
    writeFileSync(join(root, "untracked.txt"), "b\n");
    const ask = (args: readonly string[]) => {
      const ran = gitResult(root, ...args);
      return Promise.resolve({
        exitCode: ran.exitCode,
        stdout: ran.stdout.toString(),
        stderr: ran.stderr.toString(),
      });
    };
    expect(await gitFacts(ask, root)).toEqual({
      kind: "facts",
      headCommit: git(root, "rev-parse", "HEAD"),
      uncommittedPaths: 1,
    });
  });

  test("git facts are null without git or outside a work tree, counted inside one, and any other failure is reported", async () => {
    expect(await gitFacts(null, "/r")).toEqual({
      kind: "facts",
      headCommit: null,
      uncommittedPaths: null,
    });
    const answer =
      (head: { exitCode: number; stdout: string; stderr: string }) =>
      (args: readonly string[]) =>
        Promise.resolve(
          args.includes("status")
            ? { exitCode: 0, stdout: " M a\n?? b\n", stderr: "" }
            : head,
        );
    expect(
      await gitFacts(
        answer({
          exitCode: 128,
          stdout: "",
          stderr: "fatal: not a git repository (or any parent)\n",
        }),
        "/r",
      ),
    ).toEqual({ kind: "facts", headCommit: null, uncommittedPaths: null });
    expect(
      await gitFacts(
        answer({ exitCode: 0, stdout: `${pinnedCommit}\n`, stderr: "" }),
        "/r",
      ),
    ).toEqual({ kind: "facts", headCommit: pinnedCommit, uncommittedPaths: 2 });
    expect(
      await gitFacts(
        answer({ exitCode: 1, stdout: "", stderr: "\nfatal: other\n" }),
        "/r",
      ),
    ).toEqual({
      kind: "failed",
      reason: "git rev-parse HEAD exited 1: fatal: other",
    });
    expect(
      await gitFacts(
        (args) =>
          Promise.resolve(
            args.includes("status")
              ? {
                  exitCode: 128,
                  stdout: "",
                  stderr: "fatal: index is locked\n",
                }
              : { exitCode: 0, stdout: `${pinnedCommit}\n`, stderr: "" },
          ),
        "/r",
      ),
    ).toEqual({
      kind: "failed",
      reason: "git status --porcelain exited 128: fatal: index is locked",
    });
  });
});
