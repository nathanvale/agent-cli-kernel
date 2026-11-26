import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { locks, exhaustiveness, boundaries } from "./locks/cases.ts";
import ts from "typescript";

import { probeBatch } from "./locks/lock-probes.ts";
import { reviewSpecimens } from "./locks/review-specimens.ts";

const root = resolve(import.meta.dir, "../..");
const probe = probeBatch("kernel-locks-");

const lockProbes = [...locks, ...exhaustiveness, ...boundaries].map((lock) => {
  const prefix = `import * as F from ${JSON.stringify(join(root, "tests/kernel/locks/fixtures.ts"))};\n${lock.setup}\n`;
  const guarded = `${prefix}// @ts-expect-error -- ${lock.id}: accepted invalid lock\n${lock.invalid}\n`;
  const marked = probe(guarded, ["native"]);
  const invalid = probe(
    guarded.replace(
      `// @ts-expect-error -- ${lock.id}: accepted invalid lock`,
      "// removed marker",
    ),
  );
  const valid = probe(`${prefix}// valid twin\n${lock.valid}\n`);
  return { lock, marked, invalid, valid };
});
const specimens = reviewSpecimens.map((specimen) => probe(specimen.source));
const timeout = probe.timeout();

for (const { lock, marked, invalid, valid } of lockProbes)
  test(
    `${lock.id}: native rejects only its invalid line, valid twin and TS6 comparison agree`,
    async () => {
      const accepted = await marked.compile("native");
      expect(accepted.stdout).toBe("");
      expect(accepted.stderr).toBe("");
      expect(accepted.exit).toBe(0);
      const rejected = await invalid.compile("native");
      expect(rejected.exit).not.toBe(0);
      expect(rejected.stderr).toBe("");
      expect(rejected.diagnostics).toEqual([
        { file: invalid.file, code: lock.code, line: 4 },
      ]);
      expect(rejected.stdout.match(/error TS\d+:/g)).toHaveLength(1);
      expect(await valid.compile("native")).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
      const lintView = await invalid.compile("lint-view");
      expect(lintView.exit).not.toBe(0);
      expect(lintView.stderr).toBe("");
      if ("ts6Code" in lock) expect(lock.attribution.length).toBeGreaterThan(0);
      expect(lintView.diagnostics).toEqual([
        {
          file: invalid.file,
          code: "ts6Code" in lock ? lock.ts6Code : lock.code,
          line: 4,
        },
      ]);
      expect(lintView.stdout.match(/error TS\d+:/g)).toHaveLength(1);
      expect(await valid.compile("lint-view")).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
    },
    timeout,
  );

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

test(
  "review-owned specimens compile but require independent findings",
  async () => {
    expect(reviewSpecimens).toHaveLength(7);
    for (const specimen of specimens) {
      expect(await specimen.compile("native")).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
      expect(await specimen.compile("lint-view")).toMatchObject({
        exit: 0,
        stdout: "",
        stderr: "",
      });
    }
  },
  timeout,
);

test("static verdict and lint-view processes use the accepted toolchain", async () => {
  expect(Bun.version).toBe("1.4.4");
  expect(ts.version).toBe("6.0.2");
  for (const [executable, expected] of [
    ["node_modules/@typescript/native/bin/tsc", "Version 7.1.0-beta\n"],
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
    "next-full-discovery",
    "handoff-full-discovery",
    "unknown-declaration-renamed-from",
    "unknown-declaration-renamed-from-changing",
  ]);
});
