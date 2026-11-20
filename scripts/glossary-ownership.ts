import { createHash } from "node:crypto";

export const ownershipFile = "glossary-ownership.json";
export const sharedExportFile = "tests/template/naming/shared-tool-words.txt";

const sharedHeading = "### Shared tool words\n";
const termLine = /^\*\*(.+)\*\*:$/gm;

export type Source = {
  readonly commit: string;
  readonly exportSha256: string;
  readonly rewrittenHere: readonly string[];
};
export type Ownership = {
  readonly acceptedHandoff: string;
  readonly kernelEntries: readonly string[];
  readonly sharedSource: Source;
};

function refuse(message: string): never {
  throw new Error(message);
}

export function sharedSection(glossary: string): string {
  const at = glossary.indexOf(sharedHeading);
  if (at < 0 || glossary.indexOf(sharedHeading, at + sharedHeading.length) >= 0)
    refuse(
      `GLOSSARY.md needs exactly one "${sharedHeading.trim()}" heading. Repair: keep one, and no other heading with that text.`,
    );
  return glossary.slice(at);
}

export function entryNames(text: string): string[] {
  return [...text.matchAll(termLine)].map(([, name = ""]) => name);
}

function field(own: ReadonlyMap<string, unknown>, key: string): unknown {
  return own.get(key);
}

function mapOf(value: unknown, what: string): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    refuse(`${ownershipFile} needs ${what} as an object. Repair: restore it.`);
  return new Map(Object.entries(value));
}

function stringsOf(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((n) => typeof n === "string"))
    refuse(
      `${ownershipFile} needs ${what} as an array of strings. Repair: list each name as a string.`,
    );
  return value.filter((n): n is string => typeof n === "string");
}

function stringOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "")
    refuse(
      `${ownershipFile} needs ${what} as a non-empty string. Repair: write it.`,
    );
  return value;
}

export function readOwnership(text: string): Ownership {
  const own = mapOf(JSON.parse(text), "its top level");
  const source = mapOf(field(own, "sharedSource"), "sharedSource");
  const commit = stringOf(field(source, "commit"), "sharedSource.commit");
  if (!/^[0-9a-f]{40}$/.test(commit))
    refuse(
      `${ownershipFile} sharedSource.commit is not a full 40-character commit. Repair: record the full commit the export was copied from.`,
    );
  const exportSha256 = stringOf(
    field(source, "exportSha256"),
    "sharedSource.exportSha256",
  );
  return {
    acceptedHandoff: stringOf(field(own, "acceptedHandoff"), "acceptedHandoff"),
    kernelEntries: stringsOf(field(own, "kernelEntries"), "kernelEntries"),
    sharedSource: {
      commit,
      exportSha256,
      rewrittenHere: stringsOf(
        field(source, "rewrittenHere"),
        "sharedSource.rewrittenHere",
      ),
    },
  };
}

export function ownershipProblems(
  glossary: string,
  ownership: Ownership,
): string[] {
  const at = glossary.indexOf(sharedHeading);
  const own = new Set(entryNames(glossary.slice(0, at)));
  const shared = new Set(entryNames(sharedSection(glossary)));
  return [
    ...ownership.kernelEntries
      .filter((name) => !own.has(name))
      .map(
        (name) =>
          `${ownershipFile} accepts "${name}", and GLOSSARY.md does not define it outside the shared tool words. Repair: define it here, or remove it from kernelEntries.`,
      ),
    ...ownership.kernelEntries
      .filter((name) => shared.has(name))
      .map(
        (name) =>
          `${ownershipFile} accepts "${name}", a shared tool word, so it would have two owners. Repair: remove it from kernelEntries.`,
      ),
  ];
}

export function exportProblems(
  exportText: string,
  ownership: Ownership,
): string[] {
  const actual = createHash("sha256").update(exportText).digest("hex");
  return actual === ownership.sharedSource.exportSha256
    ? []
    : [
        `${sharedExportFile} does not match the exportSha256 recorded in ${ownershipFile}. Repair: copy the export again from the template commit named there, and record its hash and commit together.`,
      ];
}

function entryTexts(text: string): Map<string, string> {
  const parts = text.split(/^(?=\*\*[^*\n]+\*\*:$)/m);
  return new Map(
    parts.flatMap((part) => {
      const name = entryNames(part)[0];
      return name === undefined ? [] : [[name, part.trimEnd()] as const];
    }),
  );
}

export function sourceProblems(
  exportText: string,
  ownership: Ownership,
  sourceText: string,
): string[] {
  const here = entryTexts(exportText);
  const there = entryTexts(sourceText);
  const rewritten = new Set(ownership.sharedSource.rewrittenHere);
  const differs = [...there.keys()]
    .filter(
      (name) => !rewritten.has(name) && here.get(name) !== there.get(name),
    )
    .map(
      (name) =>
        `The export's "${name}" differs from the template at ${ownership.sharedSource.commit}. Repair: copy it from there, or list it in rewrittenHere with the reason in the pull request.`,
    );
  const unchanged = [...rewritten]
    .filter((name) => here.get(name) === there.get(name))
    .map(
      (name) =>
        `${ownershipFile} lists "${name}" in rewrittenHere, and the export's text is the template's. Repair: remove it from rewrittenHere.`,
    );
  const missing = [...here.keys()]
    .filter((name) => !there.has(name))
    .map(
      (name) =>
        `The export holds "${name}", which the template at ${ownership.sharedSource.commit} does not. Repair: remove it, or copy the section again.`,
    );
  return [...differs, ...unchanged, ...missing];
}

export function transferProblems(
  ownership: Ownership,
  templateOwnershipText: string,
): string[] {
  const there = mapOf(JSON.parse(templateOwnershipText), "its top level");
  const handoff = field(there, "handoff");
  const entries = stringsOf(field(there, "kernelEntries"), "kernelEntries");
  const same =
    entries.length === ownership.kernelEntries.length &&
    entries.every((name) => ownership.kernelEntries.includes(name));
  return [
    ...(handoff === ownership.acceptedHandoff
      ? []
      : [
          `${ownershipFile} accepts handoff "${ownership.acceptedHandoff}", and the template's transfer names "${String(handoff)}". Repair: accept the handoff the template records.`,
        ]),
    ...(same
      ? []
      : [
          `${ownershipFile} accepts a different list of entries than the template's transfer lists. Repair: make kernelEntries the template's list, and nothing else.`,
        ]),
  ];
}
