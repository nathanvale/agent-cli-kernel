import { expect, test } from "bun:test";
import { join } from "node:path";
import { runNamesCheck } from "../../../scripts/check-names.ts";
import { git } from "../../support/git-fixture.ts";
import { check, namesCheckFixture, put } from "./names-check-fixture.ts";

const { namesRepository } = namesCheckFixture();

const description = JSON.stringify({
  web: "https://github.com/nathanvale/bun-typescript-template",
  checkCommitsSince: "0".repeat(40),
  testAreas: [
    {
      name: "template",
      folder: "tests/template",
      holds: "folder",
      subfolders: true,
    },
    {
      name: "kernel",
      folder: "tests/kernel",
      holds: "files",
      subfolders: true,
    },
  ],
});

function describedRepository(): string {
  const root = namesRepository();
  put(root, "repository.json", description);
  return root;
}

const testPlaces =
  "tests/template/<area>/, tests/kernel/, tests/kernel/<area>/";

function outsideRefusal(path: string): string {
  return `${path} is a test file outside the folders repository.json gives test files. Repair: move it into one of ${testPlaces}, or add its folder to testAreas. Done when bun run check:names ${path} passes.\n`;
}

function wrongFormRefusal(path: string): string {
  return `${path} is a test file Bun runs that is not a .test.ts file, so test lints, typecheck or timings skip it. Repair: rename it to <name>.test.ts in one of ${testPlaces}. Done when bun run check:names passes on the new path.\n`;
}

function wrongFormAndOutsideRefusal(path: string): string {
  return `${path} is a test file Bun runs that is not a .test.ts file and sits outside the folders repository.json gives test files. Repair: rename it to <name>.test.ts and move it into one of ${testPlaces}, or add its folder to testAreas. Done when bun run check:names passes on the new path.\n`;
}

test.each(["tests/loose.test.ts", "tests/template/loose.test.ts"])(
  "in process: a test file at %s, outside every test area folder, is refused with the folders it may go in",
  async (path) => {
    expect(await check(describedRepository(), [path])).toEqual({
      stderr: outsideRefusal(path),
      code: 1,
    });
  },
);

test("in process: every file Bun runs as a test that is not a placed .test.ts is refused, while honest controls pass", async () => {
  const root = describedRepository();
  const refused: readonly (readonly [string, string])[] = [
    [
      "tests/kernel/sample.test.tsx",
      wrongFormRefusal("tests/kernel/sample.test.tsx"),
    ],
    [
      "tests/template/lint/sample.test.js",
      wrongFormRefusal("tests/template/lint/sample.test.js"),
    ],
    [
      "tests/template/lint/sample.test.mjs",
      wrongFormRefusal("tests/template/lint/sample.test.mjs"),
    ],
    [
      "tests/template/lint/sample.test.jsx",
      wrongFormRefusal("tests/template/lint/sample.test.jsx"),
    ],
    [
      "tests/template/lint/sample.test.cjs",
      wrongFormRefusal("tests/template/lint/sample.test.cjs"),
    ],
    [
      "tests/template/lint/sample.test.mts",
      wrongFormRefusal("tests/template/lint/sample.test.mts"),
    ],
    [
      "tests/template/lint/sample.test.cts",
      wrongFormRefusal("tests/template/lint/sample.test.cts"),
    ],
    [
      "tests/kernel/sample_test.ts",
      wrongFormRefusal("tests/kernel/sample_test.ts"),
    ],
    [
      "tests/kernel/sample.spec.ts",
      wrongFormRefusal("tests/kernel/sample.spec.ts"),
    ],
    [
      "tests/kernel/sample_spec.ts",
      wrongFormRefusal("tests/kernel/sample_spec.ts"),
    ],
    [
      "tests/template/lint/sample_test.tsx",
      wrongFormRefusal("tests/template/lint/sample_test.tsx"),
    ],
    [
      "tests/template/lint/sample.spec.js",
      wrongFormRefusal("tests/template/lint/sample.spec.js"),
    ],
    [
      "tests/template/lint/sample_spec.mjs",
      wrongFormRefusal("tests/template/lint/sample_spec.mjs"),
    ],
    [
      "tests/kernel/sample.TEST.ts",
      wrongFormRefusal("tests/kernel/sample.TEST.ts"),
    ],
    [
      "tests/kernel/sample.test.TS",
      wrongFormRefusal("tests/kernel/sample.test.TS"),
    ],
    ["tests/kernel/.test.ts", wrongFormRefusal("tests/kernel/.test.ts")],
    ["tests/kernel/_test.ts", wrongFormRefusal("tests/kernel/_test.ts")],
    ["src/sample.test.ts", outsideRefusal("src/sample.test.ts")],
    ["scripts/sample.test.ts", outsideRefusal("scripts/sample.test.ts")],
    ["kernel/src/sample.test.ts", outsideRefusal("kernel/src/sample.test.ts")],
    ["sample.test.ts", outsideRefusal("sample.test.ts")],
    ["src/sample.test.tsx", wrongFormAndOutsideRefusal("src/sample.test.tsx")],
    ["src/sample.spec.js", wrongFormAndOutsideRefusal("src/sample.spec.js")],
    [
      "scripts/sample_test.mjs",
      wrongFormAndOutsideRefusal("scripts/sample_test.mjs"),
    ],
    ["sample_spec.cjs", wrongFormAndOutsideRefusal("sample_spec.cjs")],
  ];
  for (const [path, stderr] of refused)
    expect(await check(root, [path])).toEqual({ stderr, code: 1 });

  expect(
    await check(root, [
      "tests/template/doctor/doctor.test.ts",
      "tests/template/doctor/deeper/doctor-cases.test.ts",
      "tests/kernel/state.test.ts",
      "tests/kernel/state/seam.test.ts",
      "tests/kernel/state/linux-coordination.probe.test.ts",
      "tests/support/process.ts",
      "tests/kernel/author-guide/example/tests/cli.test.ts.txt",
      "tests/kernel/diagnostics/fixtures/bare-cli.ts",
      "tests/kernel/kernel-repair/r18-spec.ts",
      "src/test.ts",
      "src/spec.ts",
      "tests/planted-faults/fault-records/0ade74f-cases.test.json",
      "tests/planted-faults/patches/0ade74f-cases.test.patch",
    ]),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: a test file in a test area folder, or straight in an area that holds files, passes", async () => {
  expect(
    await check(describedRepository(), [
      "tests/template/doctor/doctor.test.ts",
      "tests/template/doctor/deeper/doctor-cases.test.ts",
      "tests/kernel/state.test.ts",
      "tests/kernel/state/seam.test.ts",
      "tests/support/process.ts",
    ]),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: --tool-call refuses a Write that creates a test file outside every test area folder or in another Bun test form", async () => {
  const root = describedRepository();
  for (const [path, stderr] of [
    ["tests/loose.test.ts", outsideRefusal("tests/loose.test.ts")],
    ["src/sample.test.ts", outsideRefusal("src/sample.test.ts")],
    [
      "tests/kernel/sample.test.tsx",
      wrongFormRefusal("tests/kernel/sample.test.tsx"),
    ],
  ] as const) {
    const call = {
      tool_name: "Write",
      tool_input: { file_path: join(root, path) },
    };
    expect(
      await check(root, ["--tool-call"], () =>
        Promise.resolve(JSON.stringify(call)),
      ),
    ).toEqual({ stderr, code: 1 });
  }
});

test("in process: --staged refuses added test files outside every test area folder or in another Bun test form", async () => {
  const root = describedRepository();
  const staged = [
    "src/sample.test.ts",
    "tests/kernel/sample.test.tsx",
    "tests/template/lint/sample.test.js",
    "tests/template/lint/sample.test.mjs",
    "tests/template/loose.test.ts",
  ];
  for (const path of staged) {
    put(root, path, "");
    git(root, "add", "--", path);
  }
  expect(await check(root, ["--staged"])).toEqual({
    stderr: [
      outsideRefusal("src/sample.test.ts"),
      wrongFormRefusal("tests/kernel/sample.test.tsx"),
      wrongFormRefusal("tests/template/lint/sample.test.js"),
      wrongFormRefusal("tests/template/lint/sample.test.mjs"),
      outsideRefusal("tests/template/loose.test.ts"),
    ].join(""),
    code: 1,
  });
});

test("in process: a repository with no repository.json leaves test file placement unjudged", async () => {
  expect(await check(namesRepository(), ["tests/loose.test.ts"])).toEqual({
    stderr: "",
    code: 0,
  });
});

test("every tracked file Bun runs as a test is a .test.ts file in a folder repository.json gives test files", async () => {
  const root = join(import.meta.dir, "../../..");
  const independentBunTestOracle = /[._](?:test|spec)\.(?:[jt]sx?|[cm][jt]s)$/i;
  const tracked = git(root, "ls-files", "-z")
    .split("\0")
    .filter((path) => independentBunTestOracle.test(path));
  expect(tracked.length).toBeGreaterThan(0);
  expect(
    await runNamesCheck(tracked, {
      root,
      cwd: root,
      stdin: () => Promise.resolve(""),
    }),
  ).toEqual({ stderr: "", code: 0 });
});
