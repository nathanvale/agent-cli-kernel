import { expect, test } from "bun:test";
import { recordFile } from "../../../scripts/planted-faults.ts";
import { root, standards } from "./standards-documents.ts";
import {
  absent,
  allProblems,
  commitPage,
  gateOn,
  lintConfig,
  standardsFixture,
} from "./standards-fixture.ts";
import { gateProblems, rowProblems } from "./standards-rules.ts";

const fixture = standardsFixture();

test("every rule row has a guide or a gate note, and names a gate exactly when it is Partial", () => {
  expect(rowProblems(root)).toEqual([]);
});

test("every gate a rule row names exists as a script, a lint rule id or a workflow job", async () => {
  expect(await gateProblems(root)).toEqual([]);
});

test("a fixture that keeps every rule has no problems", async () => {
  expect(await allProblems(fixture(() => {}))).toEqual([]);
});

test.each([
  [
    "a guide that cites a commit outside HEAD's history",
    (files: Record<string, string>, sha: string) => {
      files["docs/standards/guide.md"] = (
        files["docs/standards/guide.md"] ?? ""
      )
        .replace(sha, absent)
        .replaceAll(sha.slice(0, 7), absent.slice(0, 7));
    },
    [
      `docs/standards/guide.md:7: [0123456] cites ${absent}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
    ],
  ],
  [
    "an inline commit link outside HEAD's history or this repository",
    (files: Record<string, string>) => {
      files["docs/standards/guide.md"] =
        `${files["docs/standards/guide.md"] ?? ""}\nSee [0123456](${commitPage}${absent}).\nSee [0123456](https://github.com/owner/other/commit/${absent}).\n`;
    },
    [
      `docs/standards/guide.md:10: [0123456] cites ${absent}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
      `docs/standards/guide.md:11: [0123456] links https://github.com/owner/other/commit/${absent}, which is not a commit page of this repository. Repair: link ${commitPage}<full sha>.`,
    ],
  ],
  [
    "a skill anchor no heading gives",
    (files: Record<string, string>) => {
      files[".agents/skills/fixture/SKILL.md"] =
        "---\nname: fixture\n---\n\n[checks](../../../AGENTS.md#check)\n";
    },
    [
      ".agents/skills/fixture/SKILL.md:5: link ../../../AGENTS.md#check names #check, which no heading in AGENTS.md gives. Repair: use one of: #fixture, #checks.",
      ".claude/skills/fixture/SKILL.md:5: link ../../../AGENTS.md#check names #check, which no heading in AGENTS.md gives. Repair: use one of: #fixture, #checks.",
    ],
  ],
  [
    "a row whose gate is gone",
    (files: Record<string, string>) => {
      files["package.json"] = '{"scripts":{}}';
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names script `fault-replay`, which package.json does not define as a script. Repair: restore the gate, or correct the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row with no guide and no gate note",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace("](#gated)", "]");
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" has no guide and no gate note. Repair: link its guide in the Guide cell, or link a heading under ## Gate notes from its Gates cell.',
      'CODING_STANDARDS.md: row "Gated rule" needs two distinct witnesses in its guide or gate note, and has 0. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
    ],
  ],
  [
    "a row whose lint and job are gone",
    (files: Record<string, string>) => {
      files["eslint.config.mjs"] = lintConfig("{ rules: {} }");
      files[".github/workflows/ci.yml"] =
        "on: pull_request\njobs:\n  other:\n    runs-on: x\n";
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names lint `repository/rule`, which no config in eslint.config.mjs turns on for a file in the repository. Repair: restore the gate, or correct the row\'s Gates cell and mark it Review only if no gate remains.',
      'CODING_STANDARDS.md: row "Gated rule" names job `fault-replay`, which no workflow in .github/workflows/ that runs on pull_request defines as a job. Repair: restore the gate, or correct the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row whose fault record is gone",
    (files: Record<string, string>) => {
      Reflect.deleteProperty(files, recordFile("fixture"));
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names fault `fixture`, which no record in tests/planted-faults/fault-records has as its id. Repair: restore the gate, or correct the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row whose lint is on only for files that do not exist",
    (files: Record<string, string>) => {
      files["eslint.config.mjs"] = lintConfig(
        '{ files: ["nowhere/**/*.ts"], rules: { "repository/rule": "error" } }',
      );
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names lint `repository/rule`, which no config in eslint.config.mjs turns on for a file in the repository. Repair: restore the gate, or correct the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row whose lint a later config turns off everywhere it applies",
    (files: Record<string, string>) => {
      files["eslint.config.mjs"] = lintConfig(
        gateOn,
        '{ files: ["**/*.mjs"], rules: { "repository/rule": "off" } }',
      );
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names lint `repository/rule`, which no config in eslint.config.mjs turns on for a file in the repository. Repair: restore the gate, or correct the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row whose job runs only outside pull requests",
    (files: Record<string, string>) => {
      files[".github/workflows/ci.yml"] =
        "on:\n  workflow_dispatch:\n  push:\n    branches: [main]\njobs:\n  fault-replay:\n    runs-on: x\n";
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names job `fault-replay`, which no workflow in .github/workflows/ that runs on pull_request defines as a job. Repair: restore the gate, or correct the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a Partial row that names no gate",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace(
        "[script `fault-replay`, lint `repository/rule`, job `fault-replay`, fault `fixture`](#gated)",
        "[Gated](#gated)",
      );
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" is Partial but names no gate. Repair: name each gate in the Gates cell as script, lint, job or fault with its id, or mark the row Review only.',
    ],
  ],
  [
    "a Review only row that names a gate",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace(
        "| Guided rule | Review only | None |",
        "| Guided rule | Review only | job `fault-replay` |",
      );
    },
    [
      'CODING_STANDARDS.md: row "Guided rule" is Review only but names a gate. Repair: mark it Partial, or set its Gates cell to None.',
    ],
  ],
  [
    "a row with a Today level the table does not define",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace(
        "| Guided rule | Review only |",
        "| Guided rule | Planned |",
      );
    },
    [
      'CODING_STANDARDS.md: row "Guided rule" has Today "Planned". Repair: use Review only or Partial.',
    ],
  ],
])(
  "%s fails, naming the file and the repair",
  async (_fault, change, expected) => {
    expect(await allProblems(fixture(change))).toEqual(expected);
  },
);
