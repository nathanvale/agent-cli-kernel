import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { probeBatch, readRun } from "./probes.ts";

const root = resolve(import.meta.dir, "../../..");
const probe = probeBatch("contract3-probes-");

const unparsable = probe("const broken = ;\n");
const mistyped = probe('const planted: number = "x";\nexport {};\n');
const clean = probe("export const fine = 1;\n");
const nativeOnly = probe("export const native = 1;\n", ["native"]);

test("a probe that fails to parse leaves every other probe's type check intact", async () => {
  for (const compiler of ["native", "lint-view"] as const) {
    const broken = await unparsable.compile(compiler);
    expect(broken.exit).not.toBe(0);
    expect(broken.diagnostics).toEqual([
      { file: unparsable.file, line: 1, code: 1109 },
    ]);
    const typed = await mistyped.compile(compiler);
    expect(typed.exit).not.toBe(0);
    expect(typed.diagnostics).toEqual([
      { file: mistyped.file, line: 1, code: 2322 },
    ]);
    expect(await clean.compile(compiler)).toMatchObject({
      exit: 0,
      stdout: "",
      stderr: "",
    });
  }
});

test("registering a probe after the first compile is refused", async () => {
  await clean.compile("native");
  expect(() => probe("export const late = 1;\n")).toThrow(
    "Register every probe at module load, before the first compile.",
  );
});

test("compiling a probe with a compiler it was not registered for is refused", async () => {
  expect(await nativeOnly.compile("native")).toMatchObject({ exit: 0 });
  expect(await nativeOnly.compile("lint-view").catch(String)).toBe(
    `Error: ${nativeOnly.file} was not registered for lint-view.`,
  );
});

const files = ["locks/probe-0.ts", "locks/probe-1.ts"];
const typeError = "locks/probe-0.ts(1,7): error TS2322: planted.\n";
const sentinel = "locks/sentinel.ts(1,14): error TS2322: sentinel.\n";

test("a clean probe reads exit 0 only from a run that completed normally", () => {
  const read = readRun("native", root, files, {
    stdout: `${typeError}${sentinel}`,
    stderr: "",
    exit: 1,
  });
  expect(read.get("locks/probe-0.ts")).toMatchObject({ exit: 1 });
  expect(read.get("locks/probe-1.ts")).toEqual({
    stdout: "",
    stderr: "",
    exit: 0,
    diagnostics: [],
  });
});

for (const [name, run] of [
  [
    "killed after writing another probe's diagnostic",
    { exit: 137, stderr: "" },
  ],
  ["crashed with a stack trace", { exit: 1, stderr: "RangeError: stack\n" }],
  ["exited 0 despite the sentinel's error", { exit: 0, stderr: "" }],
] as const)
  test(`a run that ${name} fails every probe`, () => {
    expect(() =>
      readRun("native", root, files, { stdout: typeError, ...run }),
    ).toThrow("native did not complete normally");
  });

test("a run that skipped type checking with no probe at fault fails every probe", () => {
  expect(() =>
    readRun("lint-view", root, files, { stdout: "", stderr: "", exit: 2 }),
  ).toThrow("lint-view skipped type checking but no probe failed to parse");
});
