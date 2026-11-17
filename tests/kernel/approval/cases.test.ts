import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalCases } from "./cases.ts";
import type { ApprovalCase } from "./cases.ts";

test("the frozen T4 case table keeps its admitted identities and counts", () => {
  const rows: readonly ApprovalCase[] = approvalCases;
  const families = new Set(rows.map((row) => row.id.slice(0, 3)));
  expect(families.size).toBe(25);
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  expect(rows.length).toBe(94);
  expect(rows.filter((row) => row.status === "executable").length).toBe(77);
  const pending = rows.filter((row) => row.status === "pending");
  expect(pending.length).toBe(17);
  for (const row of pending) expect(row.reason.length).toBeGreaterThan(0);
});

test("every executable case is exercised and no pending case is claimed", async () => {
  const sources = await Promise.all(
    ["component.test.ts", "process.test.ts"].map((name) =>
      Bun.file(new URL(name, import.meta.url)).text(),
    ),
  );
  const named = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/"[^"\n]*"/g)].flatMap((literal) =>
        [...literal[0].matchAll(/\b[ACS]\d\d\.[a-z]-[a-z0-9-]+/g)].map(
          (match) => match[0],
        ),
      ),
    ),
  );
  const executable = approvalCases
    .filter((row) => row.status === "executable")
    .map((row) => row.id)
    .sort();
  expect([...named].sort()).toEqual(executable);
  for (const source of sources) expect(source).toContain("expectCase(");
});

test("every executable case reaches a passing expectCase comparison", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kernel-oracle-"));
  const log = join(directory, "oracle.log");
  try {
    await writeFile(log, "");
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "tests/kernel/approval/component.test.ts",
        "tests/kernel/approval/process.test.ts",
      ],
      {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: { ...process.env, T4_ORACLE_LOG: log },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, , exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    const reached = new Set(
      (await readFile(log, "utf8")).split("\n").filter((id) => id.length > 0),
    );
    const executable = approvalCases
      .filter((row) => row.status === "executable")
      .map((row) => row.id)
      .sort();
    expect([...reached].sort()).toEqual(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);
