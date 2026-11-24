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
import { jobOf } from "../../support/workflows.ts";
import {
  check,
  glossary,
  hostHit,
  namesCheckFixture,
  put,
} from "./names-check-fixture.ts";

const { emptyRepository, namesRepository } = namesCheckFixture();

const unusedTerm = {
  term: "Fixture term",
  reason: "Nothing uses it yet.",
  ticket: "MAG-1",
};

function recordedRepository() {
  const root = namesRepository([hostHit]);
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [unusedTerm] }));
  git(root, "add", "--", recordedUnusedTermsFile);
  git(root, "commit", "--quiet", "-m", "terms");
  return root;
}

function widen(root: string, extra: Record<string, unknown> = {}) {
  put(
    root,
    recordedHitsFile,
    JSON.stringify({
      hits: [hostHit, { ...hostHit, path: "docs/proof.md", ...extra }],
    }),
  );
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
  put(root, unrelated, JSON.stringify({ hits: [{ file: "docs/term.md" }] }));
  git(root, "add", "--", unrelated);
  if (duplicate) {
    const other = "tests/template/other/recorded-hits.json";
    const otherTerms = "tests/template/other/recorded-unused-terms.json";
    put(root, other, JSON.stringify({ hits: [hostHit] }));
    put(root, otherTerms, JSON.stringify({ terms: [unusedTerm] }));
    git(root, "add", "--", other, otherTerms);
  }
  git(root, "commit", "--quiet", "-m", "earlier test area");
  for (const { current, earlier } of moved)
    git(root, "mv", "--", earlier, current);
  return root;
}

test("--against follows a moved recorded list and still refuses an unapproved addition", async () => {
  const root = earlierAreaRepository();
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
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
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
  put(root, recordedHitsFile, JSON.stringify({ hits: [] }));
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [] }));
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
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
  put(
    root,
    recordedUnusedTermsFile,
    JSON.stringify({
      terms: [unusedTerm, { ...unusedTerm, term: "Another term" }],
    }),
  );
  const { stderr, code } = await check(root, ["--against", "HEAD"]);
  expect(code).toBe(1);
  expect(stderr).toStartWith(
    `${recordedUnusedTermsFile} adds a recorded unused term "Another term", which HEAD does not record`,
  );
});

test("--against admits an addition that carries an approval, and a rewritten reason is no addition", async () => {
  const root = recordedRepository();
  widen(root, { approved: "MAG-1" });
  put(
    root,
    recordedUnusedTermsFile,
    JSON.stringify({ terms: [{ ...unusedTerm, reason: "Reworded." }] }),
  );
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
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

const repositoryRoot = join(import.meta.dir, "../../..");
const fallowBinary = join(repositoryRoot, "node_modules/.bin/fallow");
const eslintSuppressionsFile = "eslint-suppressions.json";
const coverageGapsRecordedHitsFile =
  "tests/template/standards/coverage-gaps-recorded-hits.json";
const fallowHealthRecordedHitsFile = "fallow-health-recorded-hits.json";

const baseEslintConfig =
  'export default [{ rules: { "repository/no-in-operator": "error", "no-console": "error" } }];\n';
const baseSuppressions = {
  "src/a.ts": { "repository/no-in-operator": { count: 2 } },
};
const baseCoverageGap = { path: "scripts/existing.ts", reason: "fixture" };

function recordedFilesRepository() {
  const root = recordedRepository();
  put(root, "eslint.config.mjs", baseEslintConfig);
  put(root, eslintSuppressionsFile, JSON.stringify(baseSuppressions));
  put(
    root,
    coverageGapsRecordedHitsFile,
    JSON.stringify({ hits: [baseCoverageGap] }),
  );
  git(
    root,
    "add",
    "--",
    "eslint.config.mjs",
    eslintSuppressionsFile,
    coverageGapsRecordedHitsFile,
  );
  git(root, "commit", "--quiet", "-m", "recorded files");
  return root;
}

test.each([
  [
    "eslint-suppressions.json growing an existing rule",
    (root: string) => {
      put(
        root,
        eslintSuppressionsFile,
        JSON.stringify({
          ...baseSuppressions,
          "src/b.ts": { "repository/no-in-operator": { count: 1 } },
        }),
      );
    },
    `${eslintSuppressionsFile} records 1 hit for src/b.ts repository/no-in-operator, more than HEAD records (0; rule total 3 exceeds 2). Repair: fix the lint violation and run bunx eslint . --prune-suppressions.\n`,
  ],
  [
    "eslint-suppressions.json growing a configured zero-hit rule",
    (root: string) => {
      put(
        root,
        eslintSuppressionsFile,
        JSON.stringify({
          ...baseSuppressions,
          "src/a.ts": {
            "repository/no-in-operator": { count: 2 },
            "no-console": { count: 1 },
          },
        }),
      );
    },
    `${eslintSuppressionsFile} records 1 hit for src/a.ts no-console, more than HEAD records (0; rule total 1 exceeds 0). Repair: fix the lint violation and run bunx eslint . --prune-suppressions.\n`,
  ],
  [
    "eslint-suppressions.json growing an unconfigured recommended rule",
    (root: string) => {
      put(
        root,
        eslintSuppressionsFile,
        JSON.stringify({
          ...baseSuppressions,
          "src/a.ts": {
            "repository/no-in-operator": { count: 2 },
            "no-undef": { count: 2 },
          },
        }),
      );
    },
    `${eslintSuppressionsFile} records 2 hits for src/a.ts no-undef, more than HEAD records (0; rule total 2 exceeds 0). Repair: fix the lint violation and run bunx eslint . --prune-suppressions.\n`,
  ],
  [
    "eslint-suppressions.json growing a rule only set to off in eslint.config.mjs",
    (root: string) => {
      put(
        root,
        "eslint.config.mjs",
        'export default [{ rules: { "repository/no-in-operator": "error", "no-console": "error", "no-undef": "off" } }];\n',
      );
      put(
        root,
        eslintSuppressionsFile,
        JSON.stringify({
          ...baseSuppressions,
          "src/a.ts": {
            "repository/no-in-operator": { count: 2 },
            "no-undef": { count: 1 },
          },
        }),
      );
    },
    `${eslintSuppressionsFile} records 1 hit for src/a.ts no-undef, more than HEAD records (0; rule total 1 exceeds 0). Repair: fix the lint violation and run bunx eslint . --prune-suppressions.\n`,
  ],
  [
    "coverage-gaps-recorded-hits.json adding an unapproved file gap",
    (root: string) => {
      put(
        root,
        coverageGapsRecordedHitsFile,
        JSON.stringify({
          hits: [
            baseCoverageGap,
            { path: "scripts/spawned.ts", reason: "fixture" },
          ],
        }),
      );
    },
    `${coverageGapsRecordedHitsFile} adds a recorded coverage gap for scripts/spawned.ts, which HEAD does not record, so this change widens what the import-coverage check admits. Repair: import and call it from a test, then remove the entry; or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.\n`,
  ],
  [
    "coverage-gaps-recorded-hits.json adding an unapproved export gap",
    (root: string) => {
      put(
        root,
        coverageGapsRecordedHitsFile,
        JSON.stringify({
          hits: [
            baseCoverageGap,
            { path: "scripts/runner.ts", export: "run", reason: "fixture" },
          ],
        }),
      );
    },
    `${coverageGapsRecordedHitsFile} adds a recorded coverage gap for scripts/runner.ts export run, which HEAD does not record, so this change widens what the import-coverage check admits. Repair: import and call it from a test, then remove the entry; or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.\n`,
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
  processWatchdog(7),
);

test(
  "recorded-hit growth class check admits equal, shrinking, moves, newly landed lint rules, and approved entries",
  async () => {
    const root = recordedFilesRepository();
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: "",
      code: 0,
    });

    put(
      root,
      eslintSuppressionsFile,
      JSON.stringify({
        "src/a.ts": { "repository/no-in-operator": { count: 1 } },
      }),
    );
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: "",
      code: 0,
    });

    put(
      root,
      eslintSuppressionsFile,
      JSON.stringify({
        "src/a1.ts": { "repository/no-in-operator": { count: 1 } },
        "src/a2.ts": { "repository/no-in-operator": { count: 1 } },
      }),
    );
    put(root, coverageGapsRecordedHitsFile, JSON.stringify({ hits: [] }));
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: "",
      code: 0,
    });

    put(
      root,
      "eslint.config.mjs",
      'export default [{ rules: { "repository/no-in-operator": "error", "no-console": "error", "repository/new-rule": "error" } }];\n',
    );
    put(
      root,
      eslintSuppressionsFile,
      JSON.stringify({
        "src/a.ts": { "repository/new-rule": { count: 2 } },
      }),
    );
    put(
      root,
      coverageGapsRecordedHitsFile,
      JSON.stringify({
        hits: [
          baseCoverageGap,
          { path: "scripts/spawned.ts", reason: "fixture", approved: "MAG-1" },
        ],
      }),
    );
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: "",
      code: 0,
    });

    rmSync(join(root, eslintSuppressionsFile));
    rmSync(join(root, coverageGapsRecordedHitsFile));
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: "",
      code: 0,
    });
  },
  processWatchdog(12),
);

test(
  "--against exits 2 on a malformed eslint-suppressions.json",
  async () => {
    const root = recordedFilesRepository();
    put(
      root,
      eslintSuppressionsFile,
      JSON.stringify({
        "src/a.ts": { "repository/no-in-operator": { count: -1 } },
      }),
    );
    expect(await check(root, ["--against", "HEAD"])).toEqual({
      stderr: `${eslintSuppressionsFile}: src/a.ts repository/no-in-operator needs a non-negative integer count.\n`,
      code: 2,
    });
  },
  processWatchdog(5),
);

function fallowWorkflowSteps() {
  const steps = jobOf("ci.yml", "check").steps.filter((step) =>
    step.run?.includes("quality:fallow"),
  );
  return {
    pullRequest: steps.find((step) => step.if?.includes("pull_request")),
    push: steps.find((step) => step.if?.includes("push")),
    all: steps,
  };
}

function fallowFlagsFrom(run: string, base: string): string[] {
  const after = run.split("quality:fallow")[1]?.trim() ?? "";
  return after
    .replace(/"origin\/\$\{\{ github\.base_ref \}\}"/, base)
    .split(/\s+/)
    .filter((token) => token !== "");
}

function fallowRepository() {
  const root = emptyRepository();
  put(
    root,
    "package.json",
    JSON.stringify({ name: "fixture", type: "module" }),
  );
  put(
    root,
    ".fallowrc.json",
    JSON.stringify({
      audit: { gate: "new-only", healthBaseline: fallowHealthRecordedHitsFile },
      entry: ["src/index.ts"],
    }),
  );
  put(
    root,
    "src/index.ts",
    "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
  );
  put(
    root,
    fallowHealthRecordedHitsFile,
    JSON.stringify({
      kind: "health",
      finding_counts: { "src/index.ts": { crap_moderate: { count: 1 } } },
      identity_finding_counts: {
        "src/index.ts:greet": { crap_moderate: { count: 1 } },
      },
    }),
  );
  git(
    root,
    "add",
    "--",
    "package.json",
    ".fallowrc.json",
    "src/index.ts",
    fallowHealthRecordedHitsFile,
  );
  git(root, "commit", "--quiet", "-m", "base");
  git(root, "checkout", "-q", "-b", "feature");
  return root;
}

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
    git(root, "add", "--", "src/index.ts");
    git(root, "commit", "--quiet", "-m", "equal");
    expect((await runFallow()).exit).toBe(0);

    put(
      root,
      fallowHealthRecordedHitsFile,
      JSON.stringify({
        kind: "health",
        finding_counts: {},
        identity_finding_counts: {},
      }),
    );
    git(root, "add", "--", fallowHealthRecordedHitsFile);
    git(root, "commit", "--quiet", "-m", "shrunk");
    expect((await runFallow()).exit).toBe(0);

    put(
      root,
      fallowHealthRecordedHitsFile,
      JSON.stringify({
        kind: "health",
        finding_counts: {
          "src/index.ts": {
            crap_moderate: { count: 1 },
            crap_high: { count: 1 },
          },
        },
        identity_finding_counts: {
          "src/index.ts:greet": { crap_moderate: { count: 1 } },
          "src/index.ts:extra": { crap_high: { count: 1 } },
        },
      }),
    );
    git(root, "add", "--", fallowHealthRecordedHitsFile);
    git(root, "commit", "--quiet", "-m", "grown");
    const grown = await runFallow();
    expect(grown.exit).toBe(1);
    expect(grown.stderr).toBe(
      `Baseline growth gate failed: ${join(realpathSync(root), fallowHealthRecordedHitsFile)} has 1 key that main does not have. Fix the new findings, or get a review for each new key:\n  identity_finding_counts: src/index.ts:extra crap_high (count 1)\n`,
    );
  },
  processWatchdog(6),
);
