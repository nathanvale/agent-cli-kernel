import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nameProblems,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  trackedNames,
} from "../../scripts/glossary.ts";

const root = join(import.meta.dir, "../..");

const fixture = readGlossary(`# Fixture glossary

**Recorded hit**:
A violation listed so that its check passes.
_Avoid_: known hit, allowlist

**Layout**:
One package or many.
_Avoid_: variant

_Qualify_: host, proof
`);

test("every tracked name uses glossary words, apart from its recorded hits", () => {
  const glossary = readGlossary(
    readFileSync(join(root, "GLOSSARY.md"), "utf8"),
  );
  const recorded = readRecordedHits(
    readFileSync(join(root, recordedHitsFile), "utf8"),
  );
  expect(nameProblems(trackedNames(root), glossary, recorded)).toEqual([]);
});

test("a folder and the files under it are each judged by their own name", () => {
  const names = trackedNames(root);
  expect(
    ["tests", "tests/standards", "tests/standards/standards.test.ts"].filter(
      (name) => !names.includes(name),
    ),
  ).toEqual([]);
});

test("names that use only glossary words have no problem", () => {
  expect(
    nameProblems(
      ["src", "src/test-host-lint.ts", "docs/test-proof.md", "tests/known.ts"],
      fixture,
      [],
    ),
  ).toEqual([]);
});

test.each([
  ["a file", "tests/known-hits.json", "known hit", "Recorded hit"],
  ["a folder", "src/allowlist", "allowlist", "Recorded hit"],
  ["a camel-case file", "src/layoutVariants.ts", "variant", "Layout"],
])(
  "NM.a %s named with an Avoid word is a new hit",
  (_kind, path, word, term) => {
    expect(nameProblems([path], fixture, [])).toEqual([
      `${path} uses "${word}", which GLOSSARY.md lists under Avoid for "${term}". Rename it with the glossary word.`,
    ]);
  },
);

test.each([
  ["a bare folder", "hosts"],
  ["a bare file", "docs/PROOF.md"],
  ["a bare test file", "tests/host.test.ts"],
])("NM.b %s that uses a qualify word alone is a new hit", (_kind, path) => {
  const word = path.toLowerCase().includes("host") ? "host" : "proof";
  expect(nameProblems([path], fixture, [])).toEqual([
    `${path} uses "${word}" with no qualifier. Add a word that says which ${word} it is.`,
  ]);
});

test("a recorded hit admits its name and no other", () => {
  const recorded = [{ path: "hosts", word: "host", reason: "fixture" }];
  expect(nameProblems(["hosts"], fixture, recorded)).toEqual([]);
  expect(nameProblems(["hosts", "src/hosts"], fixture, recorded)).toEqual([
    'src/hosts uses "host" with no qualifier. Add a word that says which host it is.',
  ]);
});

test.each([
  ["whose path is gone", ["src"]],
  ["whose name no longer uses the word", ["src", "src/test-hosts"]],
])("NM.c a recorded hit %s fails", (_kind, paths) => {
  const recorded = [
    { path: "src/test-hosts", word: "host", reason: "fixture" },
  ];
  expect(nameProblems(paths, fixture, recorded)).toEqual([
    `${recordedHitsFile} records "host" in src/test-hosts, which no longer occurs. Remove the entry.`,
  ]);
});

test("new name problems leave a stale recorded hit to the tracked names check", () => {
  const recorded = [
    { path: "src/test-hosts", word: "host", reason: "fixture" },
  ];
  expect(newNameProblems(["src", "hosts"], fixture, recorded)).toEqual([
    'hosts uses "host" with no qualifier. Add a word that says which host it is.',
  ]);
});

test("a recorded hit without a reason is refused", () => {
  expect(() =>
    readRecordedHits(
      JSON.stringify({ hits: [{ path: "hosts", word: "host" }] }),
    ),
  ).toThrow(
    `${recordedHitsFile}: hits[0] needs a non-empty path, word and reason.`,
  );
});
