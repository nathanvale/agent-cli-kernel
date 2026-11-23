import { expect, test } from "bun:test";
import { basename, resolve } from "node:path";
import { probeBatch, readRun } from "./lock-probes.ts";

const root = resolve(import.meta.dir, "../../..");
const probe = probeBatch("kernel-probes-");

const unparsable = probe("const broken = ;\n");
const mistyped = probe('const planted: number = "x";\nexport {};\n');
const clean = probe("export const fine = 1;\n");
const nativeOnly = probe("export const native = 1;\n", ["native"]);

test(
  "a probe that fails to parse leaves every other probe's type check intact",
  async () => {
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
  },
  probe.timeout(),
);

const leakProbe = probeBatch("kernel-probes-leaks-");
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
  test(
    `a probe that writes the global scope by ${leak.name} reaches no other probe`,
    async () => {
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
    },
    leakProbe.timeout(),
  );

const sharedFaults = [
  {
    name: "a type error",
    source: 'export const planted: number = "x";\n',
    code: 2322,
  },
  {
    name: "a syntax error",
    source: "export const planted: number = ;\n",
    code: 1109,
  },
].map((fault, index) => {
  const fixture = `shared-fixture-${index}.ts`;
  const importer = probeBatch(`kernel-probes-importers-${index}-`, {
    [fixture]: fault.source,
  });
  return {
    ...fault,
    fixture,
    importers: ["a", "b"].map((name) =>
      importer(
        `import { planted } from "../${fixture}";\nexport const ${name} = planted;\n`,
      ),
    ),
    unrelated: importer("export const unrelated = 1;\n"),
    timeout: importer.timeout(),
  };
});

for (const fault of sharedFaults)
  test(
    `${fault.name} in a file the probes import fails only the probes that import it`,
    async () => {
      for (const compiler of ["native", "lint-view"] as const) {
        for (const reader of fault.importers) {
          const read = await reader.compile(compiler);
          expect(read.exit).not.toBe(0);
          expect(
            read.diagnostics.map((found) => ({
              ...found,
              file: basename(found.file),
            })),
          ).toEqual([{ file: fault.fixture, line: 1, code: fault.code }]);
        }
        expect(await fault.unrelated.compile(compiler)).toMatchObject({
          exit: 0,
          stdout: "",
          stderr: "",
        });
      }
    },
    fault.timeout,
  );

test(
  "registering a probe after the first compile is refused",
  async () => {
    await clean.compile("native");
    expect(() => probe("export const late = 1;\n")).toThrow(
      "Register every probe at module load, before the first compile.",
    );
  },
  probe.timeout(),
);

const sizedProbe = probeBatch("kernel-probes-sized-");
sizedProbe("export const early = 1;\n");
test("registering a probe after its batch sized a test timeout is refused", () => {
  sizedProbe.timeout();
  expect(() => sizedProbe("export const late = 1;\n")).toThrow(
    "Register every probe before sizing a test timeout with timeout().",
  );
});

test(
  "compiling a probe with a compiler it was not registered for is refused",
  async () => {
    expect(await nativeOnly.compile("native")).toMatchObject({ exit: 0 });
    expect(await nativeOnly.compile("lint-view").catch(String)).toBe(
      `Error: ${nativeOnly.file} (source starts "export const native = 1;") was not registered for lint-view. Add "lint-view" to the compilers passed when registering it.`,
    );
  },
  probe.timeout(),
);

// Platform: TypeScript 6 parses nested parentheses recursively, so deep nesting
// overflows the JavaScript call stack and tsc exits at once.
const deep = {
  "deep.ts": `export const deep = ${"(".repeat(50_000)}1${")".repeat(50_000)};\n`,
};
const crasher = `import { deep } from "../deep.ts";\ndeclare global {}\nexport const read = deep;\n`;
const slow =
  'type Count<N extends number, A extends 0[] = []> = A["length"] extends N ? A : Count<N, [...A, 0]>;\nexport const slow: Count<999>["length"] = 999;\n';

async function running(prefix: string): Promise<string[]> {
  const ps = Bun.spawn(["ps", "-Aww", "-o", "args="], { stdout: "pipe" });
  const listed = await new Response(ps.stdout).text();
  await ps.exited;
  return listed.split("\n").filter((line) => line.includes(prefix));
}

const drains = (
  [
    ["programs", "lint-view"],
    ["compilers", "native"],
  ] as const
).map(([join, sibling]) => {
  const prefix = `kernel-probes-drain-${join}-`;
  const drained = probeBatch(prefix, deep);
  drained(slow, [sibling]);
  return {
    join,
    prefix,
    crasher: drained(crasher, ["lint-view"]),
    timeout: drained.timeout(),
  };
});

for (const drained of drains)
  test(
    `a failed compiler run reports only after its sibling ${drained.join} exit`,
    async () => {
      const failure = await drained.crasher
        .compile("lint-view")
        .catch((error: unknown) => error);
      expect(await running(drained.prefix)).toEqual([]);
      expect(String(failure)).toContain("lint-view did not complete normally");
    },
    drained.timeout,
  );

const files = ["locks/probe-0.ts", "locks/probe-1.ts"];
const typeError = "locks/probe-0.ts(1,7): error TS2322: planted.\n";
const sentinel = "locks/sentinel.ts(1,14): error TS2322: sentinel.\n";

test("a clean probe reads exit 0 only from a run that completed normally", () => {
  const read = readRun("native", root, files, {
    stdout: `${typeError}${sentinel}`,
    stderr: "",
    exit: 2,
  });
  expect(read.settled.get("locks/probe-0.ts")).toMatchObject({ exit: 2 });
  expect(read.settled.get("locks/probe-1.ts")).toEqual({
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
  ["crashed with a stack trace", { exit: 2, stderr: "RangeError: stack\n" }],
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
