import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doctor = join(import.meta.dir, "../scripts/doctor.ts");
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) rmSync(project, { recursive: true });
});

function projectPinning(packageManager: string): string {
  const project = mkdtempSync(join(tmpdir(), "doctor-"));
  projects.push(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ packageManager }),
  );
  return project;
}

function runDoctor(cwd: string) {
  const run = Bun.spawnSync([process.execPath, doctor], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, lines: run.stdout.toString().split("\n") };
}

test("a running Bun other than the pin fails, naming both versions and the repair", () => {
  const result = runDoctor(projectPinning("bun@0.0.1"));

  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain(
    `FAIL bun: found Bun ${Bun.version}, pinned 0.0.1. Repair: install Bun 0.0.1 (mise install bun@0.0.1, or setup-bun in CI), then bun install --frozen-lockfile.`,
  );
});

test("the pinned Bun without node_modules fails with the install repair", () => {
  const result = runDoctor(projectPinning(`bun@${Bun.version}`));

  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain(
    `ok bun: Bun ${Bun.version} matches the packageManager pin.`,
  );
  expect(result.lines).toContain(
    "FAIL toolchain: node_modules is missing. Repair: bun install --frozen-lockfile.",
  );
});
