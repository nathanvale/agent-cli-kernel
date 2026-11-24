import { afterAll, beforeAll, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Environment,
  type NamesCheckResult,
  runNamesCheck,
} from "../../../scripts/check-names.ts";
import {
  type RecordedHit,
  recordedHitsFile,
  recordedUnusedTermsFile,
} from "../../../scripts/glossary.ts";
import {
  git,
  gitEnv,
  gitResult,
  inherited,
} from "../../support/git-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";
import { jobOf } from "../../support/workflows.ts";
import { publicSurfaceFile } from "../../../scripts/public-surface.ts";

export const glossary = `# Fixture glossary

**Planted fault**:
A deliberate break in a guard.
_Avoid_: mutant, mutation

**Recorded hit**:
A violation listed so that its check passes.
_Avoid_: known hit, allowlist

_Qualify_: host, proof
`;
export const hostRefusal =
  'docs/host.md uses "host" with no qualifier. Repair: add a word that says which host it is.\n';

export const hostHit: RecordedHit = {
  path: "docs/host.md",
  word: "host",
  reason: "fixture",
};

export function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function environmentFor(
  root: string,
  stdin: () => Promise<string> = () => Promise.resolve(""),
  cwd: string = root,
): Environment {
  return { root, cwd, stdin };
}

export function check(
  root: string,
  args: readonly string[],
  stdin?: () => Promise<string>,
  cwd?: string,
): Promise<NamesCheckResult> {
  return runNamesCheck(args, environmentFor(root, stdin, cwd));
}

export function thrownBy(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

const unusedTerm = {
  term: "Fixture term",
  reason: "Nothing uses it yet.",
  ticket: "MAG-1",
};
const fallowBinary = join(import.meta.dir, "../../../node_modules/.bin/fallow");
const suppressionsFile = "eslint-suppressions.json";
const coverageGapsFile =
  "tests/template/standards/coverage-gaps-recorded-hits.json";
const fallowBaselineFile = "fallow-health-recorded-hits.json";
const eslintConfig = "eslint.config.mjs";
const templateRules = "config/template-rules.mjs";
const payloadRules = "config/payload-rules.mjs";
const baseRules = '"repository/no-in-operator": "error", "no-console": "error"';
const configWith = (extra: string = "") =>
  `export default [{ rules: { ${baseRules}${extra ? `, ${extra}` : ""} } }];\n`;
const ruleModule = (body: string = "") =>
  `export default { rules: { ${body} } };\n`;
const baseSuppressions = {
  "src/a.ts": { "repository/no-in-operator": { count: 2 } },
};
const baseCoverageGap = { path: "scripts/existing.ts", reason: "fixture" };

function putJson(root: string, file: string, value: unknown) {
  put(root, file, JSON.stringify(value));
}

function commitFiles(root: string, message: string, ...files: string[]) {
  git(root, "add", "--", ...files);
  git(root, "commit", "--quiet", "-m", message);
}

function addSuppression(
  root: string,
  rule: string,
  count: number = 1,
  file: string = "src/a.ts",
  extra: Record<string, unknown> = {},
) {
  putJson(root, suppressionsFile, {
    ...baseSuppressions,
    [file]: {
      ...(file === "src/a.ts" ? baseSuppressions["src/a.ts"] : {}),
      [rule]: { count, ...extra },
    },
  });
}

function suppressionRefusal(
  rule: string,
  count: number = 1,
  file: string = "src/a.ts",
  afterTotal: number = count,
  beforeTotal: number = 0,
  beforeCount: number = 0,
) {
  return `${suppressionsFile} records ${count} ${count === 1 ? "hit" : "hits"} for ${file} ${rule}, more than HEAD records (${beforeCount}; rule total ${afterTotal} exceeds ${beforeTotal}). Repair: fix the lint violation and run bunx eslint . --prune-suppressions; or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.\n`;
}

function coverageRefusal(target: string) {
  return `${coverageGapsFile} adds a recorded coverage gap for ${target}, which HEAD does not record, so this change widens what the import-coverage check admits. Repair: import and call it from a test, then remove the entry; or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.\n`;
}

async function expectPass(root: string) {
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
}

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

function fallowBaseline(
  finding_counts: Record<string, unknown>,
  identity_finding_counts: Record<string, unknown>,
) {
  return { kind: "health", finding_counts, identity_finding_counts };
}

export function namesCheckFixture() {
  const folders: string[] = [];
  const withheldFromGit = new Map<string, string>();
  const isolatedFromUser = new Map<string, string | undefined>();

  beforeAll(() => {
    const kept = inherited();
    for (const [name, value] of Object.entries(process.env))
      if (!(name in kept) && value !== undefined) {
        withheldFromGit.set(name, value);
        delete process.env[name];
      }
    for (const [name, value] of Object.entries(gitEnv)) {
      isolatedFromUser.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterAll(() => {
    for (const [name, value] of withheldFromGit) process.env[name] = value;
    for (const [name, value] of isolatedFromUser)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const folder of folders.splice(0))
      rmSync(folder, { recursive: true, force: true });
  });

  function folder(): string {
    const root = testFolder("names-in-process-");
    folders.push(root);
    return root;
  }

  function outsideRepository(): string {
    const root = folder();
    const probe = gitResult(root, "rev-parse", "--show-toplevel");
    if (probe.exitCode === 0)
      throw new Error(
        `${root} sits inside the repository at ${probe.stdout.toString().trim()}, so a case that needs no repository would find it. Repair: point STATE_TEST_DIR at a folder with no repository above it, or unset it. Done when git rev-parse --show-toplevel fails in ${root}.`,
      );
    return root;
  }

  function emptyRepository(): string {
    const root = folder();
    git(root, "init", "--quiet", "--initial-branch=main");
    return root;
  }

  function namesRepository(recorded: readonly RecordedHit[] = []): string {
    const root = emptyRepository();
    put(root, "GLOSSARY.md", glossary);
    put(root, recordedHitsFile, JSON.stringify({ hits: recorded }));
    put(
      root,
      publicSurfaceFile,
      JSON.stringify({ exports: [], consumedExports: [], importers: [] }),
    );
    git(root, "add", "--", "GLOSSARY.md", recordedHitsFile, publicSurfaceFile);
    git(root, "commit", "--quiet", "-m", "rules");
    return root;
  }

  function recordedRepository(): string {
    const root = namesRepository([hostHit]);
    putJson(root, recordedUnusedTermsFile, { terms: [unusedTerm] });
    commitFiles(root, "terms", recordedUnusedTermsFile);
    return root;
  }

  function recordedFilesRepository(): string {
    const root = recordedRepository();
    put(root, eslintConfig, configWith());
    put(root, templateRules, ruleModule('"no-locale-compare": {}'));
    put(root, payloadRules, ruleModule('"no-in-operator": {}'));
    putJson(root, suppressionsFile, baseSuppressions);
    putJson(root, coverageGapsFile, { hits: [baseCoverageGap] });
    commitFiles(
      root,
      "recorded files",
      eslintConfig,
      templateRules,
      payloadRules,
      suppressionsFile,
      coverageGapsFile,
    );
    return root;
  }

  function fallowRepository(): string {
    const root = emptyRepository();
    putJson(root, "package.json", { name: "fixture", type: "module" });
    putJson(root, ".fallowrc.json", {
      audit: { gate: "new-only", healthBaseline: fallowBaselineFile },
      entry: ["src/index.ts"],
    });
    put(
      root,
      "src/index.ts",
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
    );
    putJson(
      root,
      fallowBaselineFile,
      fallowBaseline(
        { "src/index.ts": { crap_moderate: { count: 1 } } },
        { "src/index.ts:greet": { crap_moderate: { count: 1 } } },
      ),
    );
    commitFiles(
      root,
      "base",
      "package.json",
      ".fallowrc.json",
      "src/index.ts",
      fallowBaselineFile,
    );
    git(root, "checkout", "-q", "-b", "feature");
    return root;
  }

  return {
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
    folder,
    namesRepository,
    outsideRepository,
    putJson,
    recordedFilesRepository,
    recordedRepository,
    ruleModule,
    suppressionRefusal,
    suppressionsFile,
    templateRules,
    unusedTerm,
  };
}
