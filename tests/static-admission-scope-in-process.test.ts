import { processWatchdog } from "./support/process.ts";
import {
  type Options,
  sourcePaths,
  normalizedPaths,
  compilerScope,
  discoveryScope,
  type Document as Fields,
  wholeReportScope,
} from "../src/static-admission.ts";
import { join, dirname } from "node:path";
import {
  mkdirSync,
  symlinkSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { test, expect } from "bun:test";
import {
  evidenceOptions,
  repository,
  type Tree,
  createAdmissionFolder,
  policyFiles,
  packet,
  grow,
  causeOf,
  fields,
  stubTool,
  editJson,
} from "./support/static-admission-in-process-fixture.ts";

const folder = createAdmissionFolder();

const realChildMilliseconds = processWatchdog(1) / 2;

function realToolOptions(project: string): Options {
  return evidenceOptions(project, realChildMilliseconds);
}

function linkTool(project: string, name: string): void {
  const path = join(project, "node_modules/.bin", name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(join(repository, "node_modules/.bin", name), path);
}

function toolProject(extra: Tree = {}): string {
  const root = folder();
  for (const file of policyFiles.filter((name) => name !== "bun.lock"))
    copyFileSync(join(packet, "simple", file), join(root, file));
  grow(root, {
    "src/cli.ts": "export const answer = 1;\n",
    "tests/cli.test.ts":
      'import { answer } from "../src/cli.ts";\nconsole.log(answer);\n',
    ...extra,
  });
  linkTool(root, "tsc");
  linkTool(root, "fallow");
  return root;
}

test("sourcePaths returns the typescript files in sorted order", () => {
  expect(
    sourcePaths({
      "tests/b.test.ts": "x",
      "package.json": "x",
      "src/z.ts": "x",
      "src/a/nested.ts": "x",
      "src/a.d.ts": "x",
      "src/view.tsx": "x",
    }),
  ).toEqual(["src/a.d.ts", "src/a/nested.ts", "src/z.ts", "tests/b.test.ts"]);
});

test("sourcePaths refuses a project with no typescript file", async () => {
  expect(await causeOf(() => sourcePaths({}))).toBe("scope:empty");
  expect(
    await causeOf(() => sourcePaths({ "package.json": "x", "src/a.js": "x" })),
  ).toBe("scope:empty");
});

test("sourcePaths refuses a typescript file outside src and tests by path", async () => {
  for (const path of [
    "scripts/run.ts",
    "run.ts",
    "srcx/a.ts",
    "a/src/b.ts",
    "src/.ts",
    "tests.ts",
  ])
    expect(
      await causeOf(() => sourcePaths({ "src/ok.ts": "x", [path]: "x" })),
    ).toBe(`scope:outside-includes:${path}`);
});

test("normalizedPaths makes each path relative to the root and sorts them", () => {
  expect(
    normalizedPaths("/work/root", [
      "./tests/c.test.ts",
      "src/b.ts",
      "/work/root/src/a.ts",
      "../other/d.ts",
    ]),
  ).toEqual(["../other/d.ts", "src/a.ts", "src/b.ts", "tests/c.test.ts"]);
});

test("normalizedPaths refuses a missing list and a non-text entry", async () => {
  for (const value of [undefined, null, "src/a.ts", { 0: "src/a.ts" }])
    expect(await causeOf(() => normalizedPaths("/r", value))).toBe(
      "scope:path-list-missing",
    );
  for (const entry of [1, null, {}, ["a"]])
    expect(await causeOf(() => normalizedPaths("/r", ["a.ts", entry]))).toBe(
      "scope:path-missing",
    );
});

test(
  "compilerScope accepts the files the real compiler lists",
  async () => {
    const project = toolProject();
    const options = realToolOptions(project);
    await compilerScope(options, ["src/cli.ts", "tests/cli.test.ts"]);
    expect(
      fields(
        JSON.parse(
          readFileSync(join(options.evidence, "compiler-config.json"), "utf8"),
        ),
      ),
    ).toMatchObject({
      argv: ["node_modules/.bin/tsc", "--showConfig", "-p", "tsconfig.json"],
      exitCode: 0,
    });
  },
  processWatchdog(1),
);

test(
  "compilerScope refuses a file list that differs from the compiler's",
  async () => {
    const project = toolProject();
    const options = realToolOptions(project);
    expect(await causeOf(() => compilerScope(options, ["src/cli.ts"]))).toBe(
      "scope:compiler-files",
    );
    expect(
      await causeOf(() =>
        compilerScope(options, ["src/cli.ts", "tests/cli.test.ts", "src/x.ts"]),
      ),
    ).toBe("scope:compiler-files");
  },
  processWatchdog(1),
);

test(
  "compilerScope refuses a failing compiler and an output that is not a document",
  async () => {
    const broken = toolProject();
    rmSync(join(broken, "tsconfig.json"));
    expect(
      await causeOf(() =>
        compilerScope(realToolOptions(broken), ["src/cli.ts"]),
      ),
    ).toBe("compiler-config:exit");
    const echoing = toolProject();
    stubTool(echoing, "tsc", "printf 'not a document'");
    expect(
      await causeOf(() =>
        compilerScope(realToolOptions(echoing), ["src/cli.ts"]),
      ),
    ).toBe("compiler-config:non-json");
  },
  processWatchdog(1),
);

test(
  "discoveryScope returns the front door, the tests and the lint rules entry",
  async () => {
    const project = toolProject();
    const options = realToolOptions(project);
    expect(
      await discoveryScope(options, ["src/cli.ts", "tests/cli.test.ts"]),
    ).toEqual(["src/cli.ts", "tests/cli.test.ts", "eslint-rules.mjs"]);
    expect(
      fields(
        JSON.parse(
          readFileSync(join(options.evidence, "whole-discovery.json"), "utf8"),
        ),
      ),
    ).toMatchObject({
      argv: [
        "node_modules/.bin/fallow",
        "list",
        "--files",
        "--entry-points",
        "--format",
        "json",
        "--quiet",
      ],
      exitCode: 0,
    });
  },
  processWatchdog(1),
);

test(
  "discoveryScope leaves a source file that no entry needs out of the entries it requires",
  async () => {
    const project = toolProject({
      "src/cli.ts":
        'import { helper } from "./helper.ts";\nexport const answer = helper;\n',
      "src/helper.ts": "export const helper = 1;\n",
    });
    const options = realToolOptions(project);
    expect(
      await discoveryScope(options, [
        "src/cli.ts",
        "src/helper.ts",
        "tests/cli.test.ts",
      ]),
    ).toEqual(["src/cli.ts", "tests/cli.test.ts", "eslint-rules.mjs"]);
  },
  processWatchdog(1),
);

test(
  "discoveryScope refuses a file list that differs from fallow's",
  async () => {
    const options = realToolOptions(toolProject());
    expect(await causeOf(() => discoveryScope(options, ["src/cli.ts"]))).toBe(
      "scope:fallow-files",
    );
    expect(
      await causeOf(() =>
        discoveryScope(options, [
          "src/cli.ts",
          "tests/cli.test.ts",
          "src/x.ts",
        ]),
      ),
    ).toBe("scope:fallow-files");
  },
  processWatchdog(1),
);

test(
  "discoveryScope refuses a project without a front door",
  async () => {
    const project = toolProject({ "src/cli.ts": "" });
    rmSync(join(project, "src/cli.ts"));
    grow(project, { "src/main.ts": "export const a = 1;\n" });
    const options = realToolOptions(project);
    expect(
      await causeOf(() =>
        discoveryScope(options, ["src/main.ts", "tests/cli.test.ts"]),
      ),
    ).toBe("scope:front-door-missing");
  },
  processWatchdog(1),
);

test(
  "discoveryScope refuses a project without a test file",
  async () => {
    const project = toolProject();
    rmSync(join(project, "tests"), { recursive: true });
    const options = realToolOptions(project);
    expect(await causeOf(() => discoveryScope(options, ["src/cli.ts"]))).toBe(
      "scope:tests-missing",
    );
  },
  processWatchdog(1),
);

test(
  "discoveryScope refuses a project whose lint rules file is no entry",
  async () => {
    const project = toolProject();
    editJson(project, ".fallowrc.json", (doc) => {
      doc.entry = ["tests/cli.test.ts"];
    });
    const options = realToolOptions(project);
    expect(
      await causeOf(() =>
        discoveryScope(options, ["src/cli.ts", "tests/cli.test.ts"]),
      ),
    ).toBe("scope:eslint-rule-entry-missing");
  },
  processWatchdog(1),
);

function listingProject(script: string): string {
  const project = toolProject();
  stubTool(project, "fallow", script);
  return project;
}

test("discoveryScope refuses a failing or unreadable listing", async () => {
  const failing = listingProject("exit 4");
  expect(
    await causeOf(() =>
      discoveryScope(evidenceOptions(failing), ["src/cli.ts"]),
    ),
  ).toBe("whole-discovery:exit");
  const plain = listingProject("printf plain");
  expect(
    await causeOf(() => discoveryScope(evidenceOptions(plain), ["src/cli.ts"])),
  ).toBe("whole-discovery:non-json");
});

test("discoveryScope refuses a listing without entry points or with a malformed entry", async () => {
  const listing = (entries: string) =>
    `{"files":["eslint-rules.mjs","eslint.config.mjs","src/cli.ts","tests/a.test.ts"]${entries}}`;
  const paths = ["src/cli.ts", "tests/a.test.ts"];
  const cases: [string, string][] = [
    [listing(""), "scope:entry-points-missing"],
    [listing(',"entry_points":{}'), "scope:entry-points-missing"],
    [listing(',"entry_points":[5]'), "scope:entry"],
    [listing(',"entry_points":[{}]'), "scope:path-missing"],
    [
      listing(',"entry_points":[{"path":"src/cli.ts"}]'),
      "scope:entry-missing:tests/a.test.ts",
    ],
  ];
  for (const [output, expected] of cases) {
    const project = listingProject(`cat <<'JSON'\n${output}\nJSON`);
    expect(
      await causeOf(() => discoveryScope(evidenceOptions(project), paths)),
    ).toBe(expected);
  }
});

test("wholeReportScope accepts a report whose manual entries match and has no diagnostics", () => {
  const entries = ["src/cli.ts", "tests/a.test.ts", "eslint-rules.mjs"];
  const report = (extra: Fields = {}) => ({
    report: {
      entry_points: { sources: { manual_entry: 2 } },
      ...extra,
    },
  });
  expect(() => wholeReportScope(report(), entries)).not.toThrow();
  expect(() =>
    wholeReportScope(report({ workspace_diagnostics: [] }), entries),
  ).not.toThrow();
});

test("wholeReportScope names the part of the report that is missing or wrong", async () => {
  const entries = ["a", "b", "c"];
  const sources = (manual: unknown) => ({
    report: { entry_points: { sources: { manual_entry: manual } } },
  });
  expect(await causeOf(() => wholeReportScope({}, entries))).toBe(
    "scope:whole-report",
  );
  expect(await causeOf(() => wholeReportScope({ report: {} }, entries))).toBe(
    "scope:whole-entries",
  );
  expect(
    await causeOf(() =>
      wholeReportScope({ report: { entry_points: {} } }, entries),
    ),
  ).toBe("scope:whole-entry-sources");
  expect(await causeOf(() => wholeReportScope(sources(3), entries))).toBe(
    "scope:whole-manual-entries",
  );
  expect(await causeOf(() => wholeReportScope(sources(1), entries))).toBe(
    "scope:whole-manual-entries",
  );
  expect(
    await causeOf(() => wholeReportScope(sources(undefined), entries)),
  ).toBe("scope:whole-manual-entries");
  expect(() => wholeReportScope(sources(2), entries)).not.toThrow();
  expect(() => wholeReportScope(sources(0), ["only"])).not.toThrow();
  expect(
    await causeOf(() =>
      wholeReportScope(
        {
          report: {
            entry_points: { sources: { manual_entry: 2 } },
            workspace_diagnostics: [{ message: "x" }],
          },
        },
        entries,
      ),
    ),
  ).toBe("scope:whole-diagnostics");
});
