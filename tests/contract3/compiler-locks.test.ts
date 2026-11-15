import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { locks, exhaustiveness, boundaries } from "./locks/cases.ts";
import ts from "typescript";

import { reviewSpecimens } from "./locks/review-specimens.ts";

const root = resolve(import.meta.dir, "../..");
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "contract3-locks-"));
  await mkdir(join(directory, "locks"));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      include: [],
      files: ["locks/probe.ts"],
    }),
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function compile(source: string, compiler: "native" | "lint-view") {
  await writeFile(join(directory, "locks/probe.ts"), source);
  const executable =
    compiler === "native"
      ? "node_modules/@typescript/native/bin/tsc"
      : "node_modules/typescript/bin/tsc6";
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, executable),
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(directory, "tsconfig.json"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const evidence = process.env.CONTRACT3_COMPILER_EVIDENCE;
  if (evidence)
    await appendFile(
      evidence,
      `${JSON.stringify({ compiler, source, executable, stdout, stderr, exit })}\n`,
    );
  return {
    stdout,
    stderr,
    exit,
    diagnostics: [
      ...stdout.matchAll(/^(.+)\((\d+),(\d+)\): error TS(\d+):/gm),
    ].map((match) => ({
      file: resolve(root, match[1] ?? ""),
      line: Number(match[2]),
      code: Number(match[4]),
    })),
  };
}

for (const lock of [...locks, ...exhaustiveness, ...boundaries]) {
  test(`${lock.id}: native rejects only its invalid line, valid twin and TS6 comparison agree`, async () => {
    const prefix = `import * as F from ${JSON.stringify(join(root, "tests/contract3/locks/fixtures.ts"))};\n${lock.setup}\n`;
    const guarded = `${prefix}// @ts-expect-error -- ${lock.id}: accepted invalid lock\n${lock.invalid}\n`;
    const marked = await compile(guarded, "native");
    expect(marked.stdout).toBe("");
    expect(marked.stderr).toBe("");
    expect(marked.exit).toBe(0);
    const invalid = guarded.replace(
      `// @ts-expect-error -- ${lock.id}: accepted invalid lock`,
      "// removed marker",
    );
    const rejected = await compile(invalid, "native");
    expect(rejected.exit).not.toBe(0);
    expect(rejected.stderr).toBe("");
    expect(rejected.diagnostics).toEqual([
      { file: join(directory, "locks/probe.ts"), code: lock.code, line: 4 },
    ]);
    expect(rejected.stdout.match(/error TS\d+:/g)).toHaveLength(1);
    const valid = `${prefix}// valid twin\n${lock.valid}\n`;
    expect(await compile(valid, "native")).toMatchObject({
      exit: 0,
      stdout: "",
      stderr: "",
    });
    const lintView = await compile(invalid, "lint-view");
    expect(lintView.exit).not.toBe(0);
    expect(lintView.stderr).toBe("");
    if ("ts6Code" in lock) expect(lock.attribution.length).toBeGreaterThan(0);
    expect(lintView.diagnostics).toEqual([
      {
        file: join(directory, "locks/probe.ts"),
        code: "ts6Code" in lock ? lock.ts6Code : lock.code,
        line: 4,
      },
    ]);
    expect(lintView.stdout.match(/error TS\d+:/g)).toHaveLength(1);
    expect(await compile(valid, "lint-view")).toMatchObject({
      exit: 0,
      stdout: "",
      stderr: "",
    });
  }, 30000);
}

test("every accepted compiler lock retains its identity", () => {
  expect(locks.map((lock) => String(lock.id)).sort()).toEqual(
    [
      "N1",
      "N2",
      "N3",
      "N4",
      "N5",
      "N6",
      "N7",
      "N8",
      "N9",
      "N10",
      "M1",
      "M2",
      "M3",
      "R1",
      "R2",
      "R3",
      "R4",
      "P1",
      "P2",
      "P3",
      "K1",
      "K2",
      "K3",
      "K4",
      "K5",
      "K6",
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "W1",
    ].sort(),
  );
});

test("review-owned specimens compile but require independent findings", async () => {
  expect(reviewSpecimens).toHaveLength(7);
  for (const specimen of reviewSpecimens) {
    expect(await compile(specimen.source, "native")).toMatchObject({
      exit: 0,
      stdout: "",
      stderr: "",
    });
    expect(await compile(specimen.source, "lint-view")).toMatchObject({
      exit: 0,
      stdout: "",
      stderr: "",
    });
  }
}, 30000);

test("static verdict and lint-view processes use the accepted toolchain", async () => {
  expect(Bun.version).toBe("1.4.4");
  expect(ts.version).toBe("6.0.2");
  for (const [executable, expected] of [
    ["node_modules/@typescript/native/bin/tsc", "Version 7.0.2\n"],
    ["node_modules/typescript/bin/tsc6", "Version 6.0.2\n"],
  ] as const) {
    const child = Bun.spawn(
      [process.execPath, join(root, executable), "--version"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(child.stdout).text()).toBe(expected);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
  }
});

test("supplementary compiler boundaries retain their independent identities", () => {
  expect(
    [...exhaustiveness, ...boundaries].map((item) => String(item.id)),
  ).toEqual([
    "full-record",
    "assert-never",
    "global-undeclared-cause",
    "global-undeclared-command",
    "handler-result-global-envelope",
  ]);
});
