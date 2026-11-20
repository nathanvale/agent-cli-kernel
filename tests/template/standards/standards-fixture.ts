import { afterAll } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { recordFile } from "../../../scripts/planted-faults.ts";
import { git } from "../../support/git-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  citationProblems,
  linkProblems,
  standards,
} from "./standards-documents.ts";
import { gateProblems, rowProblems } from "./standards-rules.ts";

export const absent = "0123456789abcdef0123456789abcdef01234567";
export const fixtureWeb =
  "https://github.com/nathanvale/bun-typescript-template";
export const commitPage = `${fixtureWeb}/commit/`;
export const thread = `${fixtureWeb}/pull/1#discussion_r1`;
export const description = {
  web: fixtureWeb,
  checkCommitsSince: absent,
  testAreas: [
    { name: "standards", folder: "tests/standards", holds: "folder" },
  ],
};
export const gateOn = '{ rules: { "repository/rule": "error" } }';

export function lintConfig(...entries: string[]): string {
  return `const repository = { rules: { rule: { create: () => ({}) } } };\nexport default [{ plugins: { repository } }, ${entries.join(", ")}];\n`;
}

export function standardsFixture() {
  const folders: string[] = [];

  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true });
  });

  function folder(): string {
    const path = testFolder("standards-");
    folders.push(path);
    return path;
  }

  function fixture(
    change: (files: Record<string, string>, sha: string) => void,
    { shallow = false } = {},
  ): string {
    const origin = folder();
    const commit = (subject: string) =>
      git(origin, "commit", "--quiet", "--allow-empty", "-m", subject);
    git(origin, "init", "--quiet", "--initial-branch=main");
    commit("base");
    const sha = git(origin, "rev-parse", "HEAD");
    const short = sha.slice(0, 7);
    let repository = origin;
    if (shallow) {
      commit("tip");
      repository = join(folder(), "clone");
      git(
        origin,
        "clone",
        "--quiet",
        "--depth",
        "1",
        pathToFileURL(origin).href,
        repository,
      );
    }
    const files: Record<string, string> = {
      "package.json": '{"scripts":{"fault-replay":"true"}}',
      "repository.json": JSON.stringify(description),
      "eslint.config.mjs": lintConfig(gateOn),
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  fault-replay:\n    runs-on: ubuntu-latest\n",
      "AGENTS.md": "# Fixture\n\n## Checks\n",
      [standards]: [
        "# Coding Standards",
        "",
        "## Rule table",
        "",
        "| Rule | Today | Gates | Guide |",
        "| --- | --- | --- | --- |",
        "| Gated rule | Partial | [script `fault-replay`, lint `repository/rule`, job `fault-replay`, fault `fixture`](#gated) | None |",
        "| Guided rule | Review only | None | [Guide](docs/standards/guide.md#lesson) |",
        "",
        "## Gate notes",
        "",
        "### Gated",
        "",
        `- Witnessed: [${short}], [r1].`,
        "",
        `[${short}]: ${commitPage}${sha}`,
        `[r1]: ${thread}`,
        "",
      ].join("\n"),
      "docs/standards/guide.md": `# Guide\n\n## Lesson\n\n- Witnessed: [${short}], [r1].\n\n[${short}]: ${commitPage}${sha}\n[r1]: ${thread}\n`,
      ".agents/skills/fixture/SKILL.md":
        "---\nname: fixture\n---\n\n[checks](../../../AGENTS.md#checks)\n",
      [recordFile("fixture")]: JSON.stringify({
        id: "fixture",
        source: `${short} base`,
      }),
    };
    change(files, sha);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), content);
    }
    mkdirSync(join(repository, ".claude/skills"), { recursive: true });
    symlinkSync(
      "../../.agents/skills/fixture",
      join(repository, ".claude/skills/fixture"),
    );
    return repository;
  }

  return fixture;
}

export async function allProblems(repository: string): Promise<string[]> {
  return [
    ...(await citationProblems(repository)),
    ...(await linkProblems(repository)),
    ...rowProblems(repository),
    ...(await gateProblems(repository)),
  ];
}
