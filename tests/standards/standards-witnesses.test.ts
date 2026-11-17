import { expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  citationProblems,
  git,
  linkProblems,
  root,
  standards,
} from "./standards-documents.ts";
import {
  absent,
  allProblems,
  commitPage,
  description,
  fixtureWeb,
  standardsFixture,
  thread,
} from "./standards-fixture.ts";

const fixture = standardsFixture();

test("every commit cited in the rule table and its guides is an ancestor of HEAD", async () => {
  expect(await citationProblems(root)).toEqual([]);
});

test("every relative link and anchor in the agent-facing files resolves, from real and .claude/skills paths", async () => {
  expect(await linkProblems(root)).toEqual([]);
});

test.each([
  [
    "a commit link to another repository",
    (files: Record<string, string>) => {
      files["docs/standards/guide.md"] = (
        files["docs/standards/guide.md"] ?? ""
      ).replace(commitPage, "https://github.com/owner/other/commit/");
    },
    (sha: string) => [
      `docs/standards/guide.md:7: [${sha.slice(0, 7)}] links https://github.com/owner/other/commit/${sha}, which is not a commit page of this repository. Repair: link ${commitPage}<full sha>.`,
      `CODING_STANDARDS.md: row "Guided rule" needs two distinct witnesses in its guide or gate note, and has 1. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.`,
    ],
  ],
  [
    "a commit link on another host",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace(
        commitPage,
        "https://gitlab.com/nathanvale/bun-typescript-template/-/commit/",
      );
    },
    (sha: string) => [
      `CODING_STANDARDS.md:16: [${sha.slice(0, 7)}] links https://gitlab.com/nathanvale/bun-typescript-template/-/commit/${sha}, which is not a commit page of this repository. Repair: link ${commitPage}<full sha>.`,
      `CODING_STANDARDS.md: row "Gated rule" needs two distinct witnesses in its guide or gate note, and has 1. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.`,
    ],
  ],
  [
    "a guide that cites one witness under two labels",
    (files: Record<string, string>, sha: string) => {
      files["docs/standards/guide.md"] = (
        files["docs/standards/guide.md"] ?? ""
      )
        .replace("[r1].", `[${sha.slice(0, 9)}].`)
        .replace(
          `[r1]: ${thread}`,
          `[${sha.slice(0, 9)}]: ${commitPage}${sha}`,
        );
    },
    () => [
      'CODING_STANDARDS.md: row "Guided rule" needs two distinct witnesses in its guide or gate note, and has 1. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
    ],
  ],
  [
    "an unbracketed SHA in prose that is not an ancestor",
    (files: Record<string, string>) => {
      files[standards] =
        `${files[standards] ?? ""}\nFixed in ${absent.slice(0, 12)}.\n`;
      files["docs/standards/guide.md"] =
        `${files["docs/standards/guide.md"] ?? ""}\nSee ${absent}.\n`;
    },
    () => [
      `CODING_STANDARDS.md:19: names commit ${absent.slice(0, 12)}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
      `docs/standards/guide.md:10: names commit ${absent}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
    ],
  ],
  [
    "a fault record whose source is not an ancestor or names no commit",
    (files: Record<string, string>, sha: string) => {
      files["tests/planted-faults/fault-records.json"] = JSON.stringify([
        { id: "fixture", source: `${sha.slice(0, 7)} fix: kept` },
        { id: "lost", source: `${absent.slice(0, 7)} fix: lost` },
        { id: "bare", source: "fix: no commit" },
      ]);
    },
    () => [
      `tests/planted-faults/fault-records.json: record "lost" names source ${absent.slice(0, 7)}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
      'tests/planted-faults/fault-records.json: record "bare" has source "fix: no commit", which does not start with its fix commit\'s SHA. Repair: write "<short sha> <subject>", as bun run planted-fault:add does.',
    ],
  ],
])(
  "%s fails, naming the commit and the repair",
  async (_fault, change, expected) => {
    const repository = fixture(change);
    expect(await allProblems(repository)).toEqual(
      expected(git(repository, ["rev-parse", "HEAD"])),
    );
  },
);

const kernelWeb = "https://github.com/owner/kernel";

test.each([
  ["a citable origin", [fixtureWeb], () => []],
  [
    "not a citable origin",
    [],
    (sha: string) => [
      `CODING_STANDARDS.md:16: [${sha.slice(0, 7)}] links ${commitPage}${sha}, which is not a commit page of this repository. Repair: link ${kernelWeb}/commit/<full sha>.`,
      `docs/standards/guide.md:7: [${sha.slice(0, 7)}] links ${commitPage}${sha}, which is not a commit page of this repository. Repair: link ${kernelWeb}/commit/<full sha>.`,
      'CODING_STANDARDS.md: row "Gated rule" needs two distinct witnesses in its guide or gate note, and has 0. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
      'CODING_STANDARDS.md: row "Guided rule" needs two distinct witnesses in its guide or gate note, and has 0. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
    ],
  ],
])(
  "a repository citing another's commits and review threads in its own history, where that one is %s",
  async (_case, citableOrigins, expected) => {
    const repository = fixture((files) => {
      files["repository.json"] = JSON.stringify({
        ...description,
        web: kernelWeb,
        citableOrigins,
      });
    });
    expect(await allProblems(repository)).toEqual(
      expected(git(repository, ["rev-parse", "HEAD"])),
    );
  },
);

test("one commit linked through this repository and a citable origin is one witness", async () => {
  const repository = fixture((files, sha) => {
    files["repository.json"] = JSON.stringify({
      ...description,
      web: kernelWeb,
      citableOrigins: [fixtureWeb],
    });
    files[standards] = (files[standards] ?? "")
      .replace(`[r1].`, "[same].")
      .replace(`[r1]: ${thread}`, `[same]: ${kernelWeb}/commit/${sha}`);
  });

  expect(await allProblems(repository)).toEqual([
    'CODING_STANDARDS.md: row "Gated rule" needs two distinct witnesses in its guide or gate note, and has 1. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
  ]);
});

test("a citable origin's commit outside HEAD's history fails", async () => {
  const repository = fixture((files) => {
    files["repository.json"] = JSON.stringify({
      ...description,
      web: kernelWeb,
      citableOrigins: [fixtureWeb],
    });
    files["docs/standards/guide.md"] =
      `${files["docs/standards/guide.md"] ?? ""}\nSee [0123456](${commitPage}${absent}).\n`;
  });
  expect(await citationProblems(repository)).toEqual([
    `docs/standards/guide.md:10: [0123456] cites ${absent}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
  ]);
});

test("a .claude/skills link to another skill fails and says how to relink it", async () => {
  const repository = fixture((files) => {
    files[".agents/skills/other/SKILL.md"] =
      files[".agents/skills/fixture/SKILL.md"] ?? "";
  });
  symlinkSync(
    "../../.agents/skills/fixture",
    join(repository, ".claude/skills/other"),
  );
  expect(await allProblems(repository)).toEqual([
    ".claude/skills/other resolves to .agents/skills/fixture, not .agents/skills/other. Repair: rm .claude/skills/other && ln -s ../../.agents/skills/other .claude/skills/other",
  ]);
});

test("a shallow clone that cuts a cited commit fails and says to fetch the history", async () => {
  const repository = fixture(() => {}, { shallow: true });
  const sha = readFileSync(join(repository, standards), "utf8").match(
    /commit\/([0-9a-f]{40})/,
  )?.[1];
  const fetch =
    "HEAD's history is cut short in this shallow clone: run `git fetch --unshallow` and rerun.";
  expect(await citationProblems(repository)).toEqual([
    `CODING_STANDARDS.md:16: [${sha?.slice(0, 7)}] cites ${sha}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA. ${fetch}`,
    `docs/standards/guide.md:7: [${sha?.slice(0, 7)}] cites ${sha}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA. ${fetch}`,
    `tests/planted-faults/fault-records.json: record "fixture" names source ${sha?.slice(0, 7)}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA. ${fetch}`,
  ]);
});
