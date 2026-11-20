import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { recordsPath } from "../../../scripts/planted-faults.ts";
import { readRepository } from "../../../scripts/repository.ts";
import {
  type Ancestry,
  type Citable,
  commitLinkProblems,
  lineOf,
  notAncestor,
} from "../../support/commit-links.ts";
import { git } from "../../support/git-fixture.ts";

export const root = join(import.meta.dir, "../../..");
export const standards = "CODING_STANDARDS.md";
const agentFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  standards,
  "docs/standards/*.md",
  ".agents/skills/**/*.md",
  ".claude/skills/**/*.md",
  ".claude/agents/*.md",
];

export function readWithCodeBlanked(path: string): string {
  let fenced = false;
  return readFileSync(path, "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, (front) => front.replace(/[^\n]/g, ""))
    .split("\n")
    .map((line) => {
      const fence = /^\s*(```|~~~)/.test(line);
      if (fence) fenced = !fenced;
      return fence || fenced ? "" : line;
    })
    .join("\n");
}

export function headings(
  text: string,
): { level: number; slug: string; index: number }[] {
  const seen = new Map<string, number>();
  return [...text.matchAll(/^(#{1,6})\s+(.+?)\s*#*$/gm)].map((match) => {
    const base = (match[2] ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      level: match[1]?.length ?? 0,
      slug: count === 0 ? base : `${base}-${count}`,
      index: match.index,
    };
  });
}

export async function matching(repository: string, patterns: string[]) {
  const found = new Set<string>();
  for (const pattern of patterns)
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: repository,
      dot: true,
      followSymlinks: true,
    }))
      found.add(path);
  return [...found].sort();
}

function links(text: string) {
  const inline = [
    ...text.matchAll(/!?\[(?:[^[\]]|\[[^\]]*\])*\]\(([^()\s]+)\)/g),
  ];
  const definitions = [...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/gm)];
  const imports = [...text.matchAll(/^@(\S+)\s*$/gm)];
  return [...inline, ...definitions, ...imports].map((match) => ({
    target: match[1] ?? "",
    line: lineOf(text, match.index),
  }));
}

function linkProblem(
  repository: string,
  view: string,
  target: string,
): string | undefined {
  const [path = "", anchor] = target.split("#");
  const resolved =
    path === ""
      ? join(repository, view)
      : resolve(dirname(join(repository, view)), decodeURI(path));
  const shown = relative(repository, resolved);
  if (shown.startsWith(".."))
    return `link ${target} leaves the repository. Repair: link a file inside it.`;
  if (!existsSync(resolved))
    return `link ${target} resolves to ${shown}, which does not exist. Repair: write the path relative to ${dirname(view)}/.`;
  if (anchor === undefined) return undefined;
  if (!statSync(resolved).isFile())
    return `link ${target} puts an anchor on folder ${shown}. Repair: link a Markdown file.`;
  const slugs = headings(readWithCodeBlanked(resolved)).map(({ slug }) => slug);
  return slugs.includes(anchor)
    ? undefined
    : `link ${target} names #${anchor}, which no heading in ${shown} gives. Repair: use one of: ${slugs.map((slug) => `#${slug}`).join(", ")}.`;
}

export async function linkProblems(repository: string): Promise<string[]> {
  const problems: string[] = [];
  for (const view of await matching(repository, agentFiles)) {
    const text = readWithCodeBlanked(join(repository, view));
    for (const { target, line } of links(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const problem = linkProblem(repository, view, target);
      if (problem !== undefined) problems.push(`${view}:${line}: ${problem}`);
    }
  }
  return [...problems, ...skillLinkProblems(repository)];
}

function skillLinkProblems(repository: string): string[] {
  const skills = join(repository, ".agents/skills");
  const skillNames = existsSync(skills) ? readdirSync(skills) : [];
  return skillNames.flatMap((skill) => {
    const link = join(repository, ".claude/skills", skill);
    const relink = `ln -s ../../.agents/skills/${skill} .claude/skills/${skill}`;
    if (!existsSync(join(link, "SKILL.md")))
      return [
        `.agents/skills/${skill} has no Claude Code link. Repair: ${relink}`,
      ];
    const target = realpathSync(link);
    return target === realpathSync(join(skills, skill))
      ? []
      : [
          `.claude/skills/${skill} resolves to ${relative(realpathSync(repository), target)}, not .agents/skills/${skill}. Repair: rm .claude/skills/${skill} && ${relink}`,
        ];
  });
}

function fetchHint(repository: string, history: string[]): string {
  const graft = resolve(
    repository,
    git(repository, "rev-parse", "--git-path", "shallow"),
  );
  const cut = existsSync(graft) ? readFileSync(graft, "utf8").split("\n") : [];
  return history.some((sha) => cut.includes(sha))
    ? " HEAD's history is cut short in this shallow clone: run `git fetch --unshallow` and rerun."
    : "";
}

const bareSha = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

export function citableOf(repository: string): Citable {
  const { web, citableWebs: webs } = readRepository(repository);
  const threads = webs.map(
    (each) =>
      new RegExp(`^${each.replaceAll(".", "\\.")}/pull/\\d+#discussion_r\\d+$`),
  );
  return {
    page: `${web}/commit/`,
    pages: webs.map((each) => `${each}/commit/`),
    isThread: (target) => threads.some((thread) => thread.test(target)),
  };
}

function ancestry(repository: string): Ancestry {
  const history = git(repository, "rev-list", "HEAD").split("\n");
  return {
    ...citableOf(repository),
    isAncestor: (sha) => history.some((each) => each.startsWith(sha)),
    fetch: fetchHint(repository, history),
  };
}

function citationsIn(file: string, text: string, history: Ancestry): string[] {
  const { defined, problems } = commitLinkProblems(file, text, history);
  for (const match of text.matchAll(/\[([0-9a-f]{7,40})\](?![[(:])/g)) {
    const [, label = ""] = match;
    if (!defined.has(label))
      problems.push(
        `${file}:${lineOf(text, match.index)}: [${label}] has no commit link. Repair: add [${label}]: ${history.page}<full sha> at the end of the file.`,
      );
  }
  const prose = text
    .replace(/^ {0,3}\[[^\]]+\]:.*$/gm, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\[[0-9a-f]{7,40}\](?:\[[^\]]*\])?/g, "");
  for (const match of prose.matchAll(bareSha))
    if (!history.isAncestor(match[0]))
      problems.push(
        `${file}:${lineOf(prose, match.index)}: names commit ${notAncestor(match[0], history)}`,
      );
  return problems;
}

export function faultRecords(
  repository: string,
): { file: string; id?: string; source?: string }[] {
  const folder = join(repository, recordsPath);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => ({
      file: `${recordsPath}/${name}`,
      ...(JSON.parse(readFileSync(join(folder, name), "utf8")) as {
        id?: string;
        source?: string;
      }),
    }));
}

function faultSourceProblems(repository: string, history: Ancestry): string[] {
  return faultRecords(repository).flatMap(({ file, id, source = "" }) => {
    const sha = /^[0-9a-f]{7,40}(?= )/.exec(source)?.[0];
    const where = `${file}: record "${id}"`;
    if (sha === undefined)
      return [
        `${where} has source "${source}", which does not start with its fix commit's SHA. Repair: write "<short sha> <subject>", as bun run planted-fault:add does.`,
      ];
    return history.isAncestor(sha)
      ? []
      : [`${where} names source ${notAncestor(sha, history)}`];
  });
}

export async function citationProblems(repository: string): Promise<string[]> {
  const history = ancestry(repository);
  const files = await matching(repository, [standards, "docs/standards/*.md"]);
  return [
    ...files.flatMap((file) =>
      citationsIn(file, readWithCodeBlanked(join(repository, file)), history),
    ),
    ...faultSourceProblems(repository, history),
  ];
}
