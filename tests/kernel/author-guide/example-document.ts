import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  byCodeUnit,
  exampleFiles,
  packageName,
  repository,
} from "./example-files.ts";

export const skillFolder = join(repository, "skills", packageName);
export const exampleDocumentPath = join(skillFolder, "references/example.md");
export const exampleTestsDocumentPath = join(
  skillFolder,
  "references/example-tests.md",
);
export const writeCommand =
  "bun run tests/kernel/author-guide/example-document.ts";

const fence = "```";
const section = /^## `([^`\n]+)`\n\n```ts\n(?:[\s\S]*?\n)??```$/gm;

export function exampleDocument(
  current: string,
  files: ReadonlyMap<string, string>,
  document = "references/example.md",
): string {
  const shown: string[] = [];
  const written = current.replace(section, (_whole, path: string) => {
    const text = files.get(path);
    if (text === undefined)
      throw new Error(
        `${document} has a section for ${path}, which is no example file. Repair: name one of ${[...files.keys()].join(", ")}, or delete the section.`,
      );
    shown.push(path);
    return `## \`${path}\`\n\n${fence}ts\n${text.trimEnd()}\n${fence}`;
  });
  const expected = [...files.keys()];
  if (JSON.stringify([...shown].sort(byCodeUnit)) !== JSON.stringify(expected))
    throw new Error(
      `${document} shows ${shown.join(", ") || "no example file"}. Repair: give it exactly one section for each of ${expected.join(", ")}. A section is a heading of the form ## \`<path>\`, a blank line, then a ts code block.`,
    );
  return written;
}

export function exampleFilesFor(
  files: ReadonlyMap<string, string>,
  prefix: "src/" | "tests/",
): ReadonlyMap<string, string> {
  return new Map([...files].filter(([path]) => path.startsWith(prefix)));
}

export const exampleDocuments = [
  {
    path: exampleDocumentPath,
    document: "references/example.md",
    prefix: "src/" as const,
  },
  {
    path: exampleTestsDocumentPath,
    document: "references/example-tests.md",
    prefix: "tests/" as const,
  },
] as const;

if (import.meta.main) {
  const files = exampleFiles();
  for (const entry of exampleDocuments) {
    writeFileSync(
      entry.path,
      exampleDocument(
        readFileSync(entry.path, "utf8"),
        exampleFilesFor(files, entry.prefix),
        entry.document,
      ),
    );
    process.stdout.write(`Wrote ${relative(repository, entry.path)}.\n`);
  }
}
