import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  nameProblems,
  readGlossary,
  recordedUnusedTermsFile,
  recordedHitsFile,
  trackedNames,
} from "../../../scripts/glossary.ts";
import { git, gitEnv, inherited } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import {
  check,
  glossary,
  hostHit,
  namesCheckFixture,
  put,
} from "./names-check-fixture.ts";

const {
  addSuppression,
  baseCoverageGap,
  commitFiles,
  configWith,
  coverageGapsFile,
  coverageRefusal,
  emptyRepository,
  eslintConfig,
  expectPass,
  fallowBaseline,
  fallowBaselineFile,
  fallowBinary,
  fallowFlagsFrom,
  fallowRepository,
  fallowWorkflowSteps,
  namesRepository,
  putJson,
  recordedFilesRepository,
  recordedRepository,
  ruleModule,
  suppressionRefusal,
  suppressionsFile,
  templateRules,
  unusedTerm,
} = namesCheckFixture();

function widen(root: string, extra: Record<string, unknown> = {}) {
  putJson(root, recordedHitsFile, {
    hits: [hostHit, { ...hostHit, path: "docs/proof.md", ...extra }],
  });
}

function earlierAreaRepository(duplicate: boolean = false) {
  const root = recordedRepository();
  const folder = "tests/template/recorded-checks";
  mkdirSync(join(root, folder), { recursive: true });
  const moved = [recordedHitsFile, recordedUnusedTermsFile].map((file) => ({
    current: file,
    earlier: `${folder}/${file.split("/").at(-1)}`,
  }));
  for (const { current, earlier } of moved)
    git(root, "mv", "--", current, earlier);
  const unrelated = "tests/template/glossary/recorded-hits.json";
  putJson(root, unrelated, { hits: [{ file: "docs/term.md" }] });
  git(root, "add", "--", unrelated);
  if (duplicate) {
    const other = "tests/template/other/recorded-hits.json";
    const otherTerms = "tests/template/other/recorded-unused-terms.json";
    putJson(root, other, { hits: [hostHit] });
    putJson(root, otherTerms, { terms: [unusedTerm] });
    git(root, "add", "--", other, otherTerms);
  }
  git(root, "commit", "--quiet", "-m", "earlier test area");
  for (const { current, earlier } of moved)
    git(root, "mv", "--", earlier, current);
  return root;
}

test("--against follows a moved recorded list and still refuses an unapproved addition", async () => {
  const root = earlierAreaRepository();
  await expectPass(root);
  widen(root);
  const refused = await check(root, ["--against", "HEAD"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toStartWith(
    `${recordedHitsFile} adds a recorded hit for "host" in docs/proof.md`,
  );
});

test("--against refuses to guess between two earlier locations for a recorded list", async () => {
  const root = earlierAreaRepository(true);
  const refused = await check(root, ["--against", "HEAD"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain(`git has no ${recordedHitsFile} at`);
});

test("a tracked symlink that points nowhere is a name the full-tree check judges", () => {
  const root = namesRepository();
  symlinkSync("nowhere", join(root, "mutation-link.md"));
  git(root, "add", "--", "mutation-link.md");
  expect(trackedNames(root)).toContain("mutation-link.md");
  expect(nameProblems(trackedNames(root), readGlossary(glossary), [])).toEqual([
    'mutation-link.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: rename it with the glossary word.',
  ]);
});

test("--against passes lists that match the base revision, and ones that only shrank", async () => {
  const root = recordedRepository();
  await expectPass(root);
  putJson(root, recordedHitsFile, { hits: [] });
  putJson(root, recordedUnusedTermsFile, { terms: [] });
  await expectPass(root);
});

test("--against refuses a recorded hit the base revision does not list, and names the repair", async () => {
  const root = recordedRepository();
  widen(root);
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: `${recordedHitsFile} adds a recorded hit for "host" in docs/proof.md, which HEAD does not record, so this change widens what the names check admits. Repair: remove it (rename the path, or use or remove the term); or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.\n`,
    code: 1,
  });
});

test("--against refuses a recorded unused term the base revision does not list", async () => {
  const root = recordedRepository();
  putJson(root, recordedUnusedTermsFile, {
    terms: [unusedTerm, { ...unusedTerm, term: "Another term" }],
  });
  const { stderr, code } = await check(root, ["--against", "HEAD"]);
  expect(code).toBe(1);
  expect(stderr).toStartWith(
    `${recordedUnusedTermsFile} adds a recorded unused term "Another term", which HEAD does not record`,
  );
});

test("--against admits an addition that carries an approval, and a rewritten reason is no addition", async () => {
  const root = recordedRepository();
  widen(root, { approved: "MAG-1" });
  putJson(root, recordedUnusedTermsFile, {
    terms: [{ ...unusedTerm, reason: "Reworded." }],
  });
  await expectPass(root);
  widen(root, { approved: "  " });
  expect((await check(root, ["--against", "HEAD"])).code).toBe(1);
});

test("--against exits 2 when the base revision does not hold a recorded file, and when it is not given one revision", async () => {
  const root = namesRepository();
  const missing = await check(root, ["--against", "HEAD"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain(
    "git has no tests/template/names-check/recorded-unused-terms.json at",
  );
  for (const args of [["--against"], ["--against", "a", "b"]])
    expect(await check(root, args)).toEqual({
      stderr:
        "Usage: bun run check:names <path> [path ...] | --staged | --tool-call | --against <revision>. --against takes one revision.\n",
      code: 2,
    });
});

test("--tool-call in this repository with no GLOSSARY.md exits 2, and in a repository with no names check exits 0", async () => {
  const broken = namesRepository();
  git(broken, "rm", "--quiet", "--", "GLOSSARY.md");
  const foreign = emptyRepository();
  const call = (file: string) => () =>
    Promise.resolve(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }),
    );
  expect(
    await check(
      broken,
      ["--tool-call"],
      call(join(broken, "docs/mutation-notes.md")),
    ),
  ).toEqual({
    stderr: `names check: ${broken} has no GLOSSARY.md or no ${recordedHitsFile}, so it cannot judge the names this call creates. Repair: restore both with git restore GLOSSARY.md ${recordedHitsFile}.\n`,
    code: 2,
  });
  expect(
    await check(
      broken,
      ["--tool-call"],
      call(join(foreign, "docs/mutation-notes.md")),
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test.each([
  [
    "eslint-suppressions.json growing an existing rule",
    (r: string) =>
      addSuppression(r, "repository/no-in-operator", 1, "src/b.ts"),
    suppressionRefusal("repository/no-in-operator", 1, "src/b.ts", 3, 2),
  ],
  [
    "eslint-suppressions.json growing a configured zero-hit rule",
    (r: string) => addSuppression(r, "no-console"),
    suppressionRefusal("no-console"),
  ],
  [
    "eslint-suppressions.json growing an unconfigured recommended rule",
    (r: string) => addSuppression(r, "no-undef", 2),
    suppressionRefusal("no-undef", 2),
  ],
  [
    "eslint-suppressions.json growing a rule only set to off in eslint.config.mjs",
    (r: string) => {
      put(r, eslintConfig, configWith('"no-undef": "off"'));
      addSuppression(r, "no-undef");
    },
    suppressionRefusal("no-undef"),
  ],
  [
    "eslint-suppressions.json growing a preset rule mentioned only in a comment",
    (r: string) => {
      put(
        r,
        eslintConfig,
        `${configWith()}// Platform: ESLint already enables { "no-debugger": "error" }.\n`,
      );
      addSuppression(r, "no-debugger");
    },
    suppressionRefusal("no-debugger"),
  ],
  [
    "eslint-suppressions.json growing a preset rule redundantly enabled in eslint.config.mjs",
    (r: string) => {
      put(r, eslintConfig, configWith('"no-debugger": "error"'));
      addSuppression(r, "no-debugger");
    },
    suppressionRefusal("no-debugger"),
  ],
  [
    "eslint-suppressions.json growing a rule on a disabled line in eslint.config.mjs",
    (r: string) => {
      put(r, eslintConfig, `${configWith()}/*\n"no-debugger": "error",\n*/\n`);
      addSuppression(r, "no-debugger");
    },
    suppressionRefusal("no-debugger"),
  ],
  [
    "eslint-suppressions.json growing a repository rule mentioned only in a rule-module comment",
    (r: string) => {
      put(r, eslintConfig, configWith('"repository/ghost-rule": "error"'));
      put(r, templateRules, ruleModule('\n// "ghost-rule": {},\n'));
      addSuppression(r, "repository/ghost-rule");
    },
    suppressionRefusal("repository/ghost-rule"),
  ],
  [
    "eslint-suppressions.json growing an existing zero-hit repository rule",
    (r: string) => addSuppression(r, "repository/no-locale-compare"),
    suppressionRefusal("repository/no-locale-compare"),
  ],
  [
    "eslint-suppressions.json growing a rule from an unlisted plugin module",
    (r: string) => {
      put(r, "config/anti-slop-rules.mjs", ruleModule('"new-rule": {}'));
      addSuppression(r, "anti-slop/new-rule");
    },
    suppressionRefusal("anti-slop/new-rule"),
  ],
  [
    "eslint-suppressions.json growing a repository rule when a base rule module cannot be decided",
    (r: string) => {
      put(r, "config/platform-rules.mjs", ruleModule("...unknownRules"));
      commitFiles(r, "undecidable base", "config/platform-rules.mjs");
      put(r, templateRules, ruleModule('"new-rule": {}'));
      put(r, eslintConfig, configWith('"repository/new-rule": "error"'));
      addSuppression(r, "repository/new-rule");
    },
    suppressionRefusal("repository/new-rule"),
  ],
  [
    "eslint-suppressions.json growing a repository rule when a base rule module has a computed outer property",
    (r: string) => {
      put(
        r,
        "config/platform-rules.mjs",
        'const key = "rules";\nexport default { rules: {}, [key]: { "existing-rule": {} } };\n',
      );
      commitFiles(r, "computed outer base", "config/platform-rules.mjs");
      put(r, "config/platform-rules.mjs", ruleModule('"existing-rule": {}'));
      addSuppression(r, "repository/existing-rule");
    },
    suppressionRefusal("repository/existing-rule"),
  ],
  [
    "eslint-suppressions.json growing a repository rule when a base rule module repeats rules",
    (r: string) => {
      put(
        r,
        "config/platform-rules.mjs",
        'export default { rules: {}, rules: { "existing-rule": {} } };\n',
      );
      commitFiles(r, "duplicate rules base", "config/platform-rules.mjs");
      put(r, "config/platform-rules.mjs", ruleModule('"existing-rule": {}'));
      addSuppression(r, "repository/existing-rule");
    },
    suppressionRefusal("repository/existing-rule"),
  ],
  [
    "eslint-suppressions.json growing a repository rule when a head rule module cannot be decided",
    (r: string) => {
      put(
        r,
        templateRules,
        'const key = "rules";\nexport default { rules: { "new-rule": {} }, [key]: {} };\n',
      );
      addSuppression(r, "repository/new-rule");
    },
    suppressionRefusal("repository/new-rule"),
  ],
  [
    "coverage-gaps-recorded-hits.json adding an unapproved file gap",
    (r: string) =>
      putJson(r, coverageGapsFile, {
        hits: [
          baseCoverageGap,
          { path: "scripts/spawned.ts", reason: "fixture" },
        ],
      }),
    coverageRefusal("scripts/spawned.ts"),
  ],
  [
    "coverage-gaps-recorded-hits.json adding an unapproved export gap",
    (r: string) =>
      putJson(r, coverageGapsFile, {
        hits: [
          baseCoverageGap,
          { path: "scripts/runner.ts", export: "run", reason: "fixture" },
        ],
      }),
    coverageRefusal("scripts/runner.ts export run"),
  ],
])(
  "recorded-hit growth class check refuses %s with its full message",
  async (_case, mutate, expected) => {
    const root = recordedFilesRepository();
    mutate(root);
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: expected,
      code: 1,
    });
  },
  processWatchdog(11),
);

test(
  "recorded-hit growth class check admits equal, shrinking, moves, and approved entries",
  async () => {
    const root = recordedFilesRepository();
    await expectPass(root);

    putJson(root, suppressionsFile, {
      "src/a.ts": { "repository/no-in-operator": { count: 1 } },
    });
    await expectPass(root);

    putJson(root, suppressionsFile, {
      "src/a1.ts": { "repository/no-in-operator": { count: 1 } },
      "src/a2.ts": { "repository/no-in-operator": { count: 1 } },
    });
    putJson(root, coverageGapsFile, { hits: [] });
    await expectPass(root);

    putJson(root, coverageGapsFile, {
      hits: [
        baseCoverageGap,
        { path: "scripts/spawned.ts", reason: "fixture", approved: "MAG-1" },
      ],
    });
    await expectPass(root);

    rmSync(join(root, suppressionsFile));
    rmSync(join(root, coverageGapsFile));
    await expectPass(root);
  },
  processWatchdog(18),
);

test(
  "recorded-hit growth class check admits a new repository rule landing with recorded hits",
  async () => {
    const root = recordedFilesRepository();
    put(root, templateRules, ruleModule('"new-rule": {}'));
    put(root, eslintConfig, configWith('"repository/new-rule": "error"'));
    addSuppression(root, "repository/new-rule", 2);
    await expectPass(root);
  },
  processWatchdog(10),
);

test(
  "--against exits 2 on a malformed eslint-suppressions.json",
  async () => {
    const root = recordedFilesRepository();
    putJson(root, suppressionsFile, {
      "src/a.ts": { "repository/no-in-operator": { count: -1 } },
    });
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: `${suppressionsFile}: src/a.ts repository/no-in-operator needs a non-negative integer count.\n`,
      code: 2,
    });
  },
  processWatchdog(6),
);

test.each([
  ["a top-level array", [], `${suppressionsFile} must be a JSON object.\n`],
  [
    "a non-object rule entry",
    { "src/a.ts": { "repository/no-in-operator": 1 } },
    `${suppressionsFile}: src/a.ts repository/no-in-operator must be a JSON object.\n`,
  ],
  [
    "a fractional count",
    { "src/a.ts": { "repository/no-in-operator": { count: 1.5 } } },
    `${suppressionsFile}: src/a.ts repository/no-in-operator needs a non-negative integer count.\n`,
  ],
])(
  "--against exits 2 on a malformed eslint-suppressions.json with %s",
  async (_case, value, expected) => {
    const root = recordedFilesRepository();
    putJson(root, suppressionsFile, value);
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: expected,
      code: 2,
    });
  },
  processWatchdog(6),
);

test(
  "recorded-hit growth class check enforces --fail-on-baseline-growth on both hosted Fallow steps and refuses growth",
  async () => {
    const { pullRequest, push, all } = fallowWorkflowSteps();
    expect(all).toHaveLength(2);
    expect(pullRequest?.run).toBe(
      'bun run --silent quality:fallow --base "origin/${{ github.base_ref }}" --fail-on-baseline-growth',
    );
    expect(push?.run).toBe(
      'bun run --silent quality:fallow --base "${{ github.event.before }}" --fail-on-baseline-growth',
    );

    const root = fallowRepository();
    const flags = fallowFlagsFrom(pullRequest?.run ?? "", "main");
    const runFallow = () =>
      spawnBounded(
        [
          fallowBinary,
          "audit",
          "--baseline-mode",
          "identity",
          "--format",
          "json",
          "--quiet",
          ...flags,
        ],
        { cwd: root, env: { ...inherited(), ...gitEnv } },
      );

    put(
      root,
      "src/index.ts",
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\nexport const kept = 1;\n",
    );
    commitFiles(root, "equal", "src/index.ts");
    expect((await runFallow()).exit).toBe(0);

    putJson(root, fallowBaselineFile, fallowBaseline({}, {}));
    commitFiles(root, "shrunk", fallowBaselineFile);
    expect((await runFallow()).exit).toBe(0);

    putJson(
      root,
      fallowBaselineFile,
      fallowBaseline(
        {
          "src/index.ts": {
            crap_moderate: { count: 1 },
            crap_high: { count: 1 },
          },
        },
        {
          "src/index.ts:greet": { crap_moderate: { count: 1 } },
          "src/index.ts:extra": { crap_high: { count: 1 } },
        },
      ),
    );
    commitFiles(root, "grown", fallowBaselineFile);
    const grown = await runFallow();
    expect(grown.exit).toBe(1);
    expect(grown.stderr).toBe(
      `Baseline growth gate failed: ${join(realpathSync(root), fallowBaselineFile)} has 1 key that main does not have. Fix the new findings, or get a review for each new key:\n  identity_finding_counts: src/index.ts:extra crap_high (count 1)\n`,
    );
  },
  processWatchdog(6),
);
