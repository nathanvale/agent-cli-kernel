import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const recordedHitsFile = "tests/naming/recorded-hits.json";
const glossaryFiles = new Set(["GLOSSARY.md", "GLOSSARY-MAP.md"]);

export type Glossary = {
  readonly terms: readonly {
    readonly name: string;
    readonly avoid: readonly string[];
  }[];
  readonly qualify: readonly string[];
};

export type RecordedHit = {
  readonly path: string;
  readonly word: string;
  readonly reason: string;
};

type NameHit = {
  readonly path: string;
  readonly word: string;
  readonly problem: string;
};

function listAfter(label: string, line: string): string[] | undefined {
  if (!line.startsWith(label)) return undefined;
  return line
    .slice(label.length)
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
}

export function readGlossary(text: string): Glossary {
  const terms: { name: string; avoid: string[] }[] = [];
  const qualify: string[] = [];
  for (const line of text.split("\n")) {
    const heading = /^\*\*(.+)\*\*:$/.exec(line)?.[1];
    if (heading !== undefined) terms.push({ name: heading, avoid: [] });
    terms.at(-1)?.avoid.push(...(listAfter("_Avoid_:", line) ?? []));
    qualify.push(...(listAfter("_Qualify_:", line) ?? []));
  }
  return { terms, qualify };
}

export function readRecordedHits(text: string): RecordedHit[] {
  const parsed: unknown = JSON.parse(text);
  const hits: unknown =
    typeof parsed === "object" && parsed !== null
      ? new Map(Object.entries(parsed)).get("hits")
      : undefined;
  if (!Array.isArray(hits))
    throw new Error(`${recordedHitsFile} needs a "hits" array.`);
  return hits.map((hit: unknown, index) => {
    const own = new Map<string, unknown>(
      typeof hit === "object" && hit !== null ? Object.entries(hit) : [],
    );
    const [path, word, reason] = ["path", "word", "reason"].map((key) =>
      own.get(key),
    );
    if (
      typeof path !== "string" ||
      typeof word !== "string" ||
      typeof reason !== "string" ||
      path === "" ||
      word === "" ||
      reason === ""
    )
      throw new Error(
        `${recordedHitsFile}: hits[${index}] needs a non-empty path, word and reason.`,
      );
    return { path, word, reason };
  });
}

function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function sameWord(found: string, word: string): boolean {
  return found === word || found === `${word}s` || found === `${word}es`;
}

function holdsPhrase(words: readonly string[], phrase: readonly string[]) {
  return words.some((_, start) =>
    phrase.every((word, at) => sameWord(words[start + at] ?? "", word)),
  );
}

function hitsIn(path: string, glossary: Glossary): NameHit[] {
  const name = (path.split("/").at(-1) ?? path).replace(/^\.+/, "");
  const words = wordsOf(name);
  const base = wordsOf(name.split(".")[0] ?? "");
  const avoided = glossary.terms.flatMap((term) =>
    term.avoid.flatMap((word) =>
      holdsPhrase(words, wordsOf(word))
        ? [
            {
              path,
              word,
              problem: `, which GLOSSARY.md lists under Avoid for "${term.name}". Rename it with the glossary word.`,
            },
          ]
        : [],
    ),
  );
  const unqualified = glossary.qualify.flatMap((word) =>
    base.length === 1 && sameWord(base[0] ?? "", word)
      ? [
          {
            path,
            word,
            problem: ` with no qualifier. Add a word that says which ${word} it is.`,
          },
        ]
      : [],
  );
  return [...avoided, ...unqualified];
}

function problemsByKind(
  paths: readonly string[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
): { fresh: string[]; stale: string[] } {
  const hits = paths.flatMap((path) => hitsIn(path, glossary));
  const same = (one: NameHit | RecordedHit, other: NameHit | RecordedHit) =>
    one.path === other.path && one.word === other.word;
  const fresh = hits.flatMap((hit) =>
    recorded.some((entry) => same(entry, hit))
      ? []
      : [`${hit.path} uses "${hit.word}"${hit.problem}`],
  );
  const stale = recorded.flatMap((entry) =>
    hits.some((hit) => same(hit, entry))
      ? []
      : [
          `${recordedHitsFile} records "${entry.word}" in ${entry.path}, which no longer occurs. Remove the entry.`,
        ],
  );
  return { fresh, stale };
}

export function newNameProblems(
  paths: readonly string[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
): string[] {
  return problemsByKind(paths, glossary, recorded).fresh;
}

export function nameProblems(
  paths: readonly string[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
): string[] {
  const { fresh, stale } = problemsByKind(paths, glossary, recorded);
  return [...fresh, ...stale];
}

function gitPaths(root: string, command: readonly string[]): string[] {
  const listed = Bun.spawnSync(["git", ...command, "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0)
    throw new Error(
      `git ${command.join(" ")} failed: ${listed.stderr.toString().trim()}`,
    );
  return listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

function gitFiles(root: string): string[] {
  return gitPaths(root, ["ls-files"]).filter((path) =>
    existsSync(join(root, path)),
  );
}

export function stagedNewPaths(root: string): string[] {
  return gitPaths(root, [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACR",
  ]);
}

export function namesOnPaths(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let end = 1; end <= parts.length; end += 1)
      names.add(parts.slice(0, end).join("/"));
  }
  return [...names];
}

export function trackedNames(root: string): string[] {
  return namesOnPaths(gitFiles(root)).sort();
}

export function trackedTexts(root: string): string[] {
  return gitFiles(root).flatMap((path) =>
    glossaryFiles.has(path) || !lstatSync(join(root, path)).isFile()
      ? []
      : [readFileSync(join(root, path), "utf8")],
  );
}

export function mapProblems(map: string, root: string): string[] {
  const paths = [...map.matchAll(/\]\(([^)\s#]+)[^)\s]*\)/g)].flatMap(
    ([, target = ""]) => (/^[a-z]+:/i.test(target) ? [] : [target]),
  );
  if (paths.length === 0)
    return [
      "GLOSSARY-MAP.md points to no glossary file, so this check would check nothing. Link each glossary it names.",
    ];
  return paths.flatMap((path) =>
    existsSync(join(root, path))
      ? []
      : [
          `GLOSSARY-MAP.md points to ${path}, which does not exist. Fix the link, or remove its row.`,
        ],
  );
}

function usePattern(term: string): RegExp {
  return new RegExp(`\\b${wordsOf(term).join("[\\s_-]*")}(?:e?s)?\\b`, "i");
}

export function unusedTerms(
  glossary: Glossary,
  texts: readonly string[],
): string[] {
  return glossary.terms.flatMap(({ name }) => {
    const use = usePattern(name);
    return texts.some((text) => use.test(text))
      ? []
      : [
          `"${name}" appears in no tracked file outside the glossary files. Use it, or remove it from GLOSSARY.md.`,
        ];
  });
}
