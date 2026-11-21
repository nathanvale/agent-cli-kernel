import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { exampleFiles } from "../author-guide/example-files.ts";
import { field, readOnlyScenario, repository } from "./harness.ts";

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
    boundMilliseconds: stepBound,
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
  for (const [path, text] of exampleFiles()) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  mkdirSync(join(folder, "verify", "scenarios"), { recursive: true });
  writeFileSync(
    join(folder, "verify", "scenarios", "read-only-command.json"),
    `${JSON.stringify(readOnlyScenario, null, 2)}\n`,
  );
  return folder;
}

test(
  "the package, installed from this checkout's HEAD by git ref, runs ready, and launches, drives, reports and cleans up a run, from node_modules",
  async () => {
    const folder = await installedRepository();
    const run = join(testFolder("kernel-verify-skill-install-run-"), "run");
    folders.push(dirname(run));
    const verify = (...argv: readonly string[]) =>
      spawnBounded(
        [
          process.execPath,
          "node_modules/agent-cli-kernel/skills/verify-cli/verify.ts",
          ...argv,
        ],
        {
          cwd: folder,
          env: { ...process.env, XDG_STATE_HOME: join(folder, "xdg-state") },
          boundMilliseconds: stepBound,
        },
      );
    const ready = await verify("ready", "src/cli.ts");
    expect({ exit: ready.exit, stderr: ready.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(ready.stdout.split("\n")[0]).toBe(
      "The target is ready: 8 readiness checks passed.",
    );
    expect((await verify("launch", run, "src/cli.ts")).exit).toBe(0);
    const drive = await verify(
      "drive",
      run,
      "verify/scenarios/read-only-command.json",
    );
    expect({ exit: drive.exit, first: drive.stdout.split("\n")[0] }).toEqual({
      exit: 0,
      first: "2 steps met.",
    });
    const report = await verify("report", run, "--json");
    expect(field(JSON.parse(report.stdout), "message")).toBe(
      "Stations: 2 swept, 1 driven, 7 owed. Steps: 2 met, 0 unmet.",
    );
    expect((await verify("cleanup", run)).exit).toBe(0);
  },
  installBound + 6 * stepBound + 10_000,
);
