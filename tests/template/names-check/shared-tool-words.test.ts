import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  entryNames,
  exportProblems,
  ownershipFile,
  ownershipProblems,
  readOwnership,
  sharedExportFile,
  sharedSection,
  sourceProblems,
  transferProblems,
} from "../../../scripts/glossary-ownership.ts";
import { trackedTexts } from "../../../scripts/glossary.ts";

const root = join(import.meta.dir, "../../..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const entry = (name: string, text = "A definition.") =>
  `**${name}**:\n${text}\n\n`;
const glossaryOf = (own: readonly string[], shared: readonly string[]) =>
  `# G\n\n### Own\n\n${own.map((n) => entry(n)).join("")}### Shared tool words\n\n${shared.map((n) => entry(n)).join("")}## Words that need a qualifier\n\n_Qualify_: host\n`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const COMMIT = "a".repeat(40);
const accepted = (entries: readonly string[], sha = "unrecorded") =>
  readOwnership(
    JSON.stringify({
      acceptedHandoff: "h",
      kernelEntries: entries,
      sharedSource: { commit: COMMIT, exportSha256: sha, rewrittenHere: [] },
    }),
  );

test("the shared tool words in GLOSSARY.md are the recorded template export, byte for byte", () => {
  expect(sharedSection(read("GLOSSARY.md"))).toBe(read(sharedExportFile));
});

test("the export is the one whose hash glossary-ownership.json records", () => {
  expect(
    exportProblems(read(sharedExportFile), readOwnership(read(ownershipFile))),
  ).toEqual([]);
});

test("every entry glossary-ownership.json accepts is defined here, outside the shared tool words", () => {
  expect(
    ownershipProblems(read("GLOSSARY.md"), readOwnership(read(ownershipFile))),
  ).toEqual([]);
});

test("the shared tool words are 32 entries", () => {
  expect(entryNames(read(sharedExportFile))).toHaveLength(32);
});

test("the export and glossary-ownership.json are not read as uses of a term", () => {
  const texts = trackedTexts(root);
  expect(texts).not.toContain(read(sharedExportFile));
  expect(texts).not.toContain(read(ownershipFile));
});

const templateRepository = process.env["TEMPLATE_REPOSITORY"];

test.skipIf(templateRepository === undefined)(
  "with a template checkout, the export and the accepted list are the template's at the recorded commit",
  () => {
    const ownership = readOwnership(read(ownershipFile));
    const show = (path: string) => {
      const run = Bun.spawnSync(
        [
          "git",
          "-C",
          String(templateRepository),
          "show",
          `${ownership.sharedSource.commit}:${path}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      return run.stdout.toString();
    };
    expect(
      sourceProblems(read(sharedExportFile), ownership, show(sharedExportFile)),
    ).toEqual([]);
    expect(transferProblems(ownership, show(ownershipFile))).toEqual([]);
  },
);

test("SA.a a glossary with two shared sections is refused", () => {
  expect(() =>
    sharedSection(`${glossaryOf([], ["Gate"])}### Shared tool words\n`),
  ).toThrow(
    'GLOSSARY.md needs exactly one "### Shared tool words" heading. Repair: keep one, and no other heading with that text.',
  );
});

test("SA.b the shared section runs to the end of the file, so a changed qualifier line is a difference", () => {
  expect(sharedSection(glossaryOf([], ["Gate"]))).toContain("_Qualify_: host");
});

test("SA.c an accepted entry that GLOSSARY.md does not define is refused", () => {
  expect(
    ownershipProblems(
      glossaryOf(["Pin"], ["Gate"]),
      accepted(["Pin", "Add-on"]),
    ),
  ).toEqual([
    'glossary-ownership.json accepts "Add-on", and GLOSSARY.md does not define it outside the shared tool words. Repair: define it here, or remove it from kernelEntries.',
  ]);
});

test("SA.d an accepted entry that is a shared tool word is refused", () => {
  expect(
    ownershipProblems(glossaryOf(["Pin"], ["Gate"]), accepted(["Pin", "Gate"])),
  ).toContain(
    'glossary-ownership.json accepts "Gate", a shared tool word, so it would have two owners. Repair: remove it from kernelEntries.',
  );
});

test("SA.e an export that does not match its recorded hash is refused", () => {
  const text = entry("Gate");
  expect(exportProblems(text, accepted([], hash(text)))).toEqual([]);
  expect(exportProblems(`${text}x`, accepted([], hash(text)))).toEqual([
    "tests/template/names-check/shared-tool-words.txt does not match the exportSha256 recorded in glossary-ownership.json. Repair: copy the export again from the template commit named there, and record its hash and commit together.",
  ]);
});

test("SA.f a commit that is not 40 hex characters is refused", () => {
  expect(() =>
    readOwnership(
      JSON.stringify({
        acceptedHandoff: "h",
        kernelEntries: [],
        sharedSource: {
          commit: "8da698a",
          exportSha256: "x",
          rewrittenHere: [],
        },
      }),
    ),
  ).toThrow(
    "glossary-ownership.json sharedSource.commit is not a full 40-character commit. Repair: record the full commit the export was copied from.",
  );
});

test("SA.g kernelEntries that is not an array of strings is refused", () => {
  const refusal =
    "glossary-ownership.json needs kernelEntries as an array of strings. Repair: list each name as a string.";
  const base = {
    acceptedHandoff: "h",
    sharedSource: { commit: COMMIT, exportSha256: "x", rewrittenHere: [] },
  };
  expect(() => readOwnership(JSON.stringify({ ...base }))).toThrow(refusal);
  expect(() =>
    readOwnership(JSON.stringify({ ...base, kernelEntries: [1] })),
  ).toThrow(refusal);
});

test("SA.h a source entry that differs from the export is refused unless it is listed as rewritten here", () => {
  const source = entry("Gate", "Template text.") + entry("Doctor");
  const exported = entry("Gate", "Kernel text.") + entry("Doctor");
  expect(sourceProblems(exported, accepted([]), source)).toEqual([
    `The export's "Gate" differs from the template at ${COMMIT}. Repair: copy it from there, or list it in rewrittenHere with the reason in the pull request.`,
  ]);
  const listed = readOwnership(
    JSON.stringify({
      acceptedHandoff: "h",
      kernelEntries: [],
      sharedSource: {
        commit: COMMIT,
        exportSha256: "x",
        rewrittenHere: ["Gate"],
      },
    }),
  );
  expect(sourceProblems(exported, listed, source)).toEqual([]);
});

test("SA.i a rewritten-here entry whose text is the template's is refused", () => {
  const same = entry("Gate");
  const listed = readOwnership(
    JSON.stringify({
      acceptedHandoff: "h",
      kernelEntries: [],
      sharedSource: {
        commit: COMMIT,
        exportSha256: "x",
        rewrittenHere: ["Gate"],
      },
    }),
  );
  expect(sourceProblems(same, listed, same)).toEqual([
    "glossary-ownership.json lists \"Gate\" in rewrittenHere, and the export's text is the template's. Repair: remove it from rewrittenHere.",
  ]);
});

test("SA.j an export entry the template does not hold is refused", () => {
  expect(
    sourceProblems(entry("Gate") + entry("Extra"), accepted([]), entry("Gate")),
  ).toEqual([
    `The export holds "Extra", which the template at ${COMMIT} does not. Repair: remove it, or copy the section again.`,
  ]);
});

test("SA.k a different handoff or a different list than the template's transfer is refused", () => {
  const template = (handoff: string, entries: readonly string[]) =>
    JSON.stringify({ handoff, kernelEntries: entries });
  expect(transferProblems(accepted(["Pin"]), template("h", ["Pin"]))).toEqual(
    [],
  );
  expect(
    transferProblems(accepted(["Pin"]), template("other", ["Pin"])),
  ).toEqual([
    'glossary-ownership.json accepts handoff "h", and the template\'s transfer names "other". Repair: accept the handoff the template records.',
  ]);
  expect(
    transferProblems(accepted(["Pin"]), template("h", ["Pin", "Gate"])),
  ).toEqual([
    "glossary-ownership.json accepts a different list of entries than the template's transfer lists. Repair: make kernelEntries the template's list, and nothing else.",
  ]);
});
