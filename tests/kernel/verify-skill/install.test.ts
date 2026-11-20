import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { field, readJson, repository, targetEntry } from "./harness.ts";

const installBound = 90_000;
const stepBound = 30_000;

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

async function installedRepository(): Promise<string> {
  const head = await spawnBounded(["git", "rev-parse", "HEAD"], {
    cwd: repository,
    env: { ...inherited(), ...gitEnv },
  });
  expect(head.exit).toBe(0);
  const folder = testFolder("kernel-verify-skill-install-");
  folders.push(folder);
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({
      name: "verify-skill-install",
      private: true,
      type: "module",
      dependencies: {
        "agent-cli-kernel": `git+file://${repository}#${head.stdout.trim()}`,
      },
    }),
  );
  writeFileSync(join(folder, "bunfig.toml"), '[install]\nauto = "disable"\n');
  const installed = await spawnBounded([process.execPath, "install"], {
    cwd: folder,
    env: { ...inherited(), ...gitEnv },
    boundMilliseconds: installBound,
  });
  expect({
    exit: installed.exit,
    output: installed.exit === 0 ? "" : installed.stdout + installed.stderr,
  }).toEqual({ exit: 0, output: "" });
  mkdirSync(join(folder, "src"));
  copyFileSync(targetEntry, join(folder, "src", "cli.ts"));
  return folder;
}

test(
  "the skill's helper, installed from this checkout's HEAD by git ref, launches, drives, cleans up and keeps its evidence from node_modules",
  async () => {
    const folder = await installedRepository();
    const state = join(folder, "state");
    const verify = (...argv: readonly string[]) =>
      spawnBounded(
        [
          process.execPath,
          "node_modules/agent-cli-kernel/skills/verify-agent-cli/verify.ts",
          ...argv,
        ],
        {
          cwd: folder,
          env: { ...process.env, XDG_STATE_HOME: state },
          boundMilliseconds: stepBound,
        },
      );
    const doctor = await verify("doctor");
    expect({ exit: doctor.exit, stderr: doctor.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect((await verify("launch", "r1")).exit).toBe(0);
    const drive = await verify(
      "drive",
      "r1",
      "status",
      '["status","--json"]',
      "--expect-exit",
      "0",
      "--expect-cause",
      "SUCCESS_UNCHANGED",
    );
    expect({ exit: drive.exit, stderr: drive.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect((await verify("cleanup", "r1")).exit).toBe(0);
    const listed = await verify("evidence", "r1", "--json");
    expect(field(JSON.parse(listed.stdout), "result", "data")).toMatchObject({
      scratch: "removed",
      steps: [{ step: "status", exitCode: 0, unmet: 0 }],
    });
    expect(
      readJson(join(state, "verify-agent-cli/runs/r1/evidence/status.json")),
    ).toMatchObject({ causeCode: "SUCCESS_UNCHANGED", oneEnvelope: true });
  },
  installBound + 6 * stepBound,
);
