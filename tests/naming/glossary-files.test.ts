import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapProblems,
  readGlossary,
  trackedTexts,
  unusedTerms,
} from "../../scripts/glossary.ts";

const root = join(import.meta.dir, "../..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("every path GLOSSARY-MAP.md points to exists", () => {
  expect(mapProblems(read("GLOSSARY-MAP.md"), root)).toEqual([]);
});

test("every GLOSSARY.md term is used in a tracked file outside the glossary files", () => {
  expect(
    unusedTerms(readGlossary(read("GLOSSARY.md")), trackedTexts(root)),
  ).toEqual([]);
});

test("the glossary files are not read as uses of their own terms", () => {
  const texts = trackedTexts(root);
  expect(texts).not.toContain(read("GLOSSARY.md"));
  expect(texts).not.toContain(read("GLOSSARY-MAP.md"));
  expect(texts).toContain(read("AGENTS.md"));
});

test("a map whose links all resolve has no problem", () => {
  expect(
    mapProblems("[here](GLOSSARY.md) and [web](https://example.test/x)", root),
  ).toEqual([]);
});

test("GM.a a map pointer to a missing path fails", () => {
  expect(
    mapProblems(
      "[here](GLOSSARY.md) and [gone](missing/GLOSSARY.md#language)",
      root,
    ),
  ).toEqual([
    "GLOSSARY-MAP.md points to missing/GLOSSARY.md, which does not exist. Fix the link, or remove its row.",
  ]);
});

test("GM.b a map that points to no file fails", () => {
  expect(
    mapProblems("Only [a web page](https://example.test/x).", root),
  ).toEqual([
    "GLOSSARY-MAP.md points to no glossary file, so this check would check nothing. Link each glossary it names.",
  ]);
});

const fixture = readGlossary(`# Fixture glossary

**CLI starter**:
A program to start from.

**Test area**:
Tests that run together.
`);

test.each([
  ["prose that wraps a line", "two CLI\nstarters in one test area"],
  ["a camel-case name", "const testAreas = [cliStarter];"],
  ["a kebab-case name", "cli-starter.ts and test-area.ts"],
])("terms used in %s count as used", (_kind, text) => {
  expect(unusedTerms(fixture, [text])).toEqual([]);
});

test("GM.c a glossary term used nowhere fails", () => {
  expect(
    unusedTerms(fixture, ["a test area", "a starter for the CLI"]),
  ).toEqual([
    '"CLI starter" appears in no tracked file outside the glossary files. Use it, or remove it from GLOSSARY.md.',
  ]);
});
