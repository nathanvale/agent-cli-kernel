import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { testFolder } from "../../support/test-folder.ts";
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

const leakProbe = probeBatch("contract3-probes-leaks-");
const leaks = [
  {
    name: "declare global",
    writers: [
      "declare global { var leakedGlobal: string }\n",
      "declare global { var leakedGlobal: number }\n",
    ],
    reader: "export const read = leakedGlobal;\n",
    code: 2304,
  },
  {
    name: "module augmentation",
    writers: [
      'declare module "bun" { interface Env { LEAKED_SETTING: string } }\n',
    ],
    reader: "export const setting: string = Bun.env.LEAKED_SETTING;\n",
    code: 2322,
  },
  {
    name: "reference directive",
    writers: ['/// <reference lib="webworker" />\n'],
    reader: "export type Scope = WorkerGlobalScope;\n",
    code: 2304,
  },
].map((leak) => ({
  ...leak,
  writers: leak.writers.map((source) => leakProbe(source, ["native"])),
  reader: leakProbe(leak.reader, ["native"]),
}));

for (const leak of leaks)
  test(`a probe that writes the global scope by ${leak.name} reaches no other probe`, async () => {
    for (const writer of leak.writers)
      expect(await writer.compile("native")).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
    const read = await leak.reader.compile("native");
    expect(read.diagnostics).toEqual([
      { file: leak.reader.file, line: 1, code: leak.code },
    ]);
  });

const fixtureDirectory = testFolder("contract3-probes-fixture-");
const fixture = join(fixtureDirectory, "shared-fixture.ts");
writeFileSync(fixture, 'export const planted: number = "x";\n');
afterAll(() => rm(fixtureDirectory, { recursive: true, force: true }));
const importer = probeBatch("contract3-probes-importers-");
const importers = [
  importer(
    `import { planted } from ${JSON.stringify(fixture)};\nexport const a = planted;\n`,
  ),
  importer(
    `import { planted } from ${JSON.stringify(fixture)};\nexport const b = planted;\n`,
  ),
];

test("an error in a file the probes import fails every probe that imports it", async () => {
  for (const compiler of ["native", "lint-view"] as const)
    for (const reader of importers) {
      const read = await reader.compile(compiler);
      expect(read.exit).not.toBe(0);
      expect(
        read.diagnostics.map((found) => ({
          ...found,
          file: basename(found.file),
        })),
      ).toEqual([{ file: "shared-fixture.ts", line: 1, code: 2322 }]);
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
    `Error: ${nativeOnly.file} (source starts "export const native = 1;") was not registered for lint-view. Add "lint-view" to the compilers passed when registering it.`,
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
