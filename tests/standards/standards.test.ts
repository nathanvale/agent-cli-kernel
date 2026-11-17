import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { readRepository } from "../../scripts/repository.ts";
import { testFolder } from "../support/test-folder.ts";

const root = join(import.meta.dir, "../..");
const standards = "CODING_STANDARDS.md";
const agentFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  standards,
  "docs/standards/*.md",
  ".agents/skills/**/*.md",
  ".claude/skills/**/*.md",
  ".claude/agents/*.md",
];
const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

type Row = { rule: string; today: string; gates: string; guide: string };
type Gate = { kind: "script" | "lint" | "job" | "fault"; id: string };

function readWithCodeBlanked(path: string): string {
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

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function headings(
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

async function matching(repository: string, patterns: string[]) {
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
    return `link ${target} leaves the repository. Link a file inside it.`;
  if (!existsSync(resolved))
    return `link ${target} resolves to ${shown}, which does not exist. Fix the path relative to ${dirname(view)}/.`;
  if (anchor === undefined) return undefined;
  if (!statSync(resolved).isFile())
    return `link ${target} puts an anchor on folder ${shown}. Link a Markdown file.`;
  const slugs = headings(readWithCodeBlanked(resolved)).map(({ slug }) => slug);
  return slugs.includes(anchor)
    ? undefined
    : `link ${target} names #${anchor}, which no heading in ${shown} gives. Use one of: ${slugs.map((slug) => `#${slug}`).join(", ")}.`;
}

async function linkProblems(repository: string): Promise<string[]> {
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
        `.agents/skills/${skill} has no Claude Code link. Run: ${relink}`,
      ];
    const target = realpathSync(link);
    return target === realpathSync(join(skills, skill))
      ? []
      : [
          `.claude/skills/${skill} resolves to ${relative(realpathSync(repository), target)}, not .agents/skills/${skill}. Run: rm .claude/skills/${skill} && ${relink}`,
        ];
  });
}

function git(
  repository: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repository,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function fetchHint(repository: string, history: string[]): string {
  const graft = resolve(
    repository,
    git(repository, ["rev-parse", "--git-path", "shallow"]),
  );
  const cut = existsSync(graft) ? readFileSync(graft, "utf8").split("\n") : [];
  return history.some((sha) => cut.includes(sha))
    ? " HEAD's history is cut short in this shallow clone: run `git fetch --unshallow` and rerun."
    : "";
}

const shortSha = /^[0-9a-f]{7,40}$/;
const bareSha = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

type Citable = {
  page: string;
  pages: string[];
  isThread: (target: string) => boolean;
};
type Ancestry = Citable & {
  isAncestor: (sha: string) => boolean;
  fetch: string;
};

function citableOf(repository: string): Citable {
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
  const history = git(repository, ["rev-list", "HEAD"]).split("\n");
  return {
    ...citableOf(repository),
    isAncestor: (sha) => history.some((each) => each.startsWith(sha)),
    fetch: fetchHint(repository, history),
  };
}

function notAncestor(sha: string, { fetch }: Ancestry): string {
  return `${sha}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.${fetch}`;
}

function commitLinkProblems(
  file: string,
  text: string,
  history: Ancestry,
): { defined: Set<string>; problems: string[] } {
  const problems: string[] = [];
  const defined = new Set<string>();
  const links = [
    ...[...text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(\S+)/gm)].map((match) => ({
      match,
      definition: true,
    })),
    ...[...text.matchAll(/\[([^\]]+)\]\(([^()\s]+)\)/g)].map((match) => ({
      match,
      definition: false,
    })),
  ];
  for (const { match, definition } of links) {
    const [, label = "", target = ""] = match;
    if (!shortSha.test(label) && !target.includes("/commit/")) continue;
    const where = `${file}:${lineOf(text, match.index)}: [${label}]`;
    if (definition) defined.add(label);
    const page = history.pages.find((each) => target.startsWith(each));
    const sha = page === undefined ? "" : target.slice(page.length);
    if (!/^[0-9a-f]{40}$/.test(sha))
      problems.push(
        `${where} links ${target}, which is not a commit page of this repository. Link ${history.page}<full sha>.`,
      );
    else if (shortSha.test(label) && !sha.startsWith(label))
      problems.push(
        `${where} links commit ${sha}. Make the label the start of that SHA.`,
      );
    else if (!history.isAncestor(sha))
      problems.push(`${where} cites ${notAncestor(sha, history)}`);
  }
  return { defined, problems };
}

function citationsIn(file: string, text: string, history: Ancestry): string[] {
  const { defined, problems } = commitLinkProblems(file, text, history);
  for (const match of text.matchAll(/\[([0-9a-f]{7,40})\](?![[(:])/g)) {
    const [, label = ""] = match;
    if (!defined.has(label))
      problems.push(
        `${file}:${lineOf(text, match.index)}: [${label}] has no commit link. Add [${label}]: ${history.page}<full sha> at the end of the file.`,
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

const manifest = "tests/faults/manifest.json";

function faultRecords(repository: string): { id?: string; source?: string }[] {
  const path = join(repository, manifest);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as {
        id?: string;
        source?: string;
      }[])
    : [];
}

function faultSourceProblems(repository: string, history: Ancestry): string[] {
  return faultRecords(repository).flatMap(({ id, source = "" }) => {
    const sha = /^[0-9a-f]{7,40}(?= )/.exec(source)?.[0];
    const where = `${manifest}: record "${id}"`;
    if (sha === undefined)
      return [
        `${where} has source "${source}", which does not start with its fix commit's SHA. Write "<short sha> <subject>", as bun run faults:add does.`,
      ];
    return history.isAncestor(sha)
      ? []
      : [`${where} names source ${notAncestor(sha, history)}`];
  });
}

async function citationProblems(repository: string): Promise<string[]> {
  const history = ancestry(repository);
  const files = await matching(repository, [standards, "docs/standards/*.md"]);
  return [
    ...files.flatMap((file) =>
      citationsIn(file, readWithCodeBlanked(join(repository, file)), history),
    ),
    ...faultSourceProblems(repository, history),
  ];
}

function ruleTable(repository: string): {
  rows: Row[];
  gateNotes: string[];
  problems: string[];
} {
  const text = readWithCodeBlanked(join(repository, standards));
  const section = (name: string) =>
    text.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
  const lines = section("Rule table")
    .split("\n")
    .filter((line) => line.startsWith("|"));
  const cells = (line: string) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  const header = cells(lines[0] ?? "|");
  const column = (name: string) => header.indexOf(name);
  const missing = ["Rule", "Today", "Gates", "Guide"].filter(
    (name) => column(name) === -1,
  );
  const problems = missing.map(
    (name) =>
      `${standards}: the rule table has no ${name} column. Restore it, since the standards test and the repo-gardener skill read it.`,
  );
  const rows = lines.slice(2).map((line) => {
    const row = cells(line);
    const cell = (name: string) => row[column(name)] ?? "";
    return {
      rule: cell("Rule"),
      today: cell("Today"),
      gates: cell("Gates"),
      guide: cell("Guide"),
    };
  });
  const gateNotes = headings(`## Gate notes\n${section("Gate notes")}`)
    .filter(({ level }) => level === 3)
    .map(({ slug }) => slug);
  if (rows.length === 0)
    problems.push(`${standards}: the rule table has no rows.`);
  return { rows, gateNotes, problems };
}

function gatesOf(row: Row): Gate[] {
  return [...row.gates.matchAll(/\b(script|lint|job|fault) `([^`]+)`/g)].map(
    ([, kind, id]) => ({ kind: kind as Gate["kind"], id: id ?? "" }),
  );
}

const levels = new Map([
  [
    "Partial",
    {
      gated: true,
      fix: "is Partial but names no gate. Name each gate in the Gates cell as script, lint, job or fault with its id, or mark the row Review only.",
    },
  ],
  [
    "Review only",
    {
      gated: false,
      fix: "is Review only but names a gate. Mark it Partial, or set its Gates cell to None.",
    },
  ],
]);

function levelProblem(row: Row): string | undefined {
  const level = levels.get(row.today);
  if (level === undefined)
    return `has Today "${row.today}". Use Review only or Partial.`;
  return gatesOf(row).length > 0 === level.gated ? undefined : level.fix;
}

function section(text: string, slug: string): string {
  const all = headings(text);
  const start = all.findIndex((heading) => heading.slug === slug);
  const heading = all[start];
  if (heading === undefined) return "";
  const end = all
    .slice(start + 1)
    .find(({ level }) => level <= heading.level)?.index;
  return text.slice(heading.index, end);
}

function witnessesIn(
  text: string,
  slug: string | undefined,
  { pages, isThread }: Citable,
): string[] {
  const targets = new Map(
    [...text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(\S+)/gm)].map(
      ([, label = "", target = ""]) => [label, target],
    ),
  );
  const part = slug === undefined ? text : section(text, slug);
  return [...part.matchAll(/\[([^\]]+)\](?![[(:])/g)].flatMap(
    ([, label = ""]) => {
      const target = targets.get(label) ?? "";

      return pages.some((page) => target.startsWith(page)) || isThread(target)
        ? [target]
        : [];
    },
  );
}

function rowWitnesses(
  repository: string,
  row: Row,
  notes: string[],
  citable: Citable,
) {
  const guides = [
    ...row.guide.matchAll(/\]\(([^)#]*)(?:#([^)]+))?\)/g),
  ].flatMap(([, path = "", anchor]) => {
    const file = join(repository, path === "" ? standards : path);
    return existsSync(file) && statSync(file).isFile()
      ? witnessesIn(readWithCodeBlanked(file), anchor, citable)
      : [];
  });
  const text = readWithCodeBlanked(join(repository, standards));
  return new Set([
    ...guides,
    ...notes.flatMap((anchor) => witnessesIn(text, anchor, citable)),
  ]);
}

function rowProblems(repository: string): string[] {
  const { rows, gateNotes, problems } = ruleTable(repository);
  const citable = citableOf(repository);
  for (const row of rows) {
    const where = `${standards}: row "${row.rule}"`;
    const hasGuide = /\]\([^)]+\)/.test(row.guide);
    const notes = [...row.gates.matchAll(/\]\(#([^)]+)\)/g)].map(
      ([, anchor]) => anchor ?? "",
    );
    if (!hasGuide && !notes.some((anchor) => gateNotes.includes(anchor)))
      problems.push(
        `${where} has no guide and no gate note. Link its guide in the Guide cell, or link a heading under ## Gate notes from its Gates cell.`,
      );
    const witnesses = rowWitnesses(repository, row, notes, citable).size;
    if (witnesses < 2)
      problems.push(
        `${where} needs two distinct witnesses in its guide or gate note, and has ${witnesses}. Cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.`,
      );
    const level = levelProblem(row);
    if (level !== undefined) problems.push(`${where} ${level}`);
  }
  return problems;
}

async function lintIds(repository: string): Promise<Set<string>> {
  const eslint = new ESLint({ cwd: repository });
  const paths = git(repository, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]).split("\n");
  const configs = (await Promise.all(
    paths.map((path) => eslint.calculateConfigForFile(path)),
  )) as ({ rules?: Record<string, unknown> } | undefined)[];
  const on = (setting: unknown) => {
    const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
    return severity !== 0 && severity !== "off";
  };
  return new Set(
    configs.flatMap((config) =>
      Object.entries(config?.rules ?? {})
        .filter(([, setting]) => on(setting))
        .map(([id]) => id),
    ),
  );
}

function runsOnPullRequest(on: unknown): boolean {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  return (
    typeof on === "object" && on !== null && Object.hasOwn(on, "pull_request")
  );
}

async function jobIds(repository: string): Promise<Set<string>> {
  const files = await matching(repository, [".github/workflows/*.{yml,yaml}"]);
  const jobs = await Promise.all(
    files.map(async (file) => {
      const document = Bun.YAML.parse(
        await Bun.file(join(repository, file)).text(),
      ) as { on?: unknown; jobs?: Record<string, unknown> } | null;
      return runsOnPullRequest(document?.on)
        ? Object.keys(document?.jobs ?? {})
        : [];
    }),
  );
  return new Set(jobs.flat());
}

async function gateProblems(repository: string): Promise<string[]> {
  const { scripts = {} } = (await Bun.file(
    join(repository, "package.json"),
  ).json()) as { scripts?: Record<string, string> };
  const known = {
    script: {
      ids: new Set(Object.keys(scripts)),
      owner: "package.json does not define as a script",
    },
    lint: {
      ids: await lintIds(repository),
      owner:
        "no config in eslint.config.mjs turns on for a file in the repository",
    },
    job: {
      ids: await jobIds(repository),
      owner:
        "no workflow in .github/workflows/ that runs on pull_request defines as a job",
    },
    fault: {
      ids: new Set(faultRecords(repository).map(({ id }) => id)),
      owner: `no record in ${manifest} has as its id`,
    },
  };
  return ruleTable(repository).rows.flatMap((row) =>
    gatesOf(row)
      .filter(({ kind, id }) => !known[kind].ids.has(id))
      .map(
        ({ kind, id }) =>
          `${standards}: row "${row.rule}" names ${kind} \`${id}\`, which ${known[kind].owner}. Restore the gate, or fix the row's Gates cell and mark it Review only if no gate remains.`,
      ),
  );
}

test("every commit cited in the rule table and its guides is an ancestor of HEAD", async () => {
  expect(await citationProblems(root)).toEqual([]);
});

test("every relative link and anchor in the agent-facing files resolves, from real and .claude/skills paths", async () => {
  expect(await linkProblems(root)).toEqual([]);
});

test("every rule row has a guide or a gate note, and names a gate exactly when it is Partial", () => {
  expect(rowProblems(root)).toEqual([]);
});

test("every gate a rule row names exists as a script, a lint rule id or a workflow job", async () => {
  expect(await gateProblems(root)).toEqual([]);
});

const fixtureGitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const absent = "0123456789abcdef0123456789abcdef01234567";
const fixtureWeb = "https://github.com/nathanvale/bun-typescript-template";
const commitPage = `${fixtureWeb}/commit/`;
const thread = `${fixtureWeb}/pull/1#discussion_r1`;
const description = {
  web: fixtureWeb,
  checkCommitsSince: absent,
  testAreas: [
    { name: "standards", folder: "tests/standards", holds: "folder" },
  ],
};
const gateOn = '{ rules: { "repository/rule": "error" } }';

function lintConfig(...entries: string[]): string {
  return `const repository = { rules: { rule: { create: () => ({}) } } };\nexport default [{ plugins: { repository } }, ${entries.join(", ")}];\n`;
}

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
    git(
      origin,
      ["commit", "--quiet", "--allow-empty", "-m", subject],
      fixtureGitEnv,
    );
  git(origin, ["init", "--quiet", "--initial-branch=main"], fixtureGitEnv);
  commit("base");
  const sha = git(origin, ["rev-parse", "HEAD"]);
  const short = sha.slice(0, 7);
  let repository = origin;
  if (shallow) {
    commit("tip");
    repository = join(folder(), "clone");
    git(
      origin,
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        pathToFileURL(origin).href,
        repository,
      ],
      fixtureGitEnv,
    );
  }
  const files: Record<string, string> = {
    "package.json": '{"scripts":{"faults":"true"}}',
    "repository.json": JSON.stringify(description),
    "eslint.config.mjs": lintConfig(gateOn),
    ".github/workflows/ci.yml":
      "on: pull_request\njobs:\n  faults:\n    runs-on: ubuntu-latest\n",
    "AGENTS.md": "# Fixture\n\n## Checks\n",
    [standards]: [
      "# Coding Standards",
      "",
      "## Rule table",
      "",
      "| Rule | Today | Gates | Guide |",
      "| --- | --- | --- | --- |",
      "| Gated rule | Partial | [script `faults`, lint `repository/rule`, job `faults`, fault `fixture`](#gated) | None |",
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
    [manifest]: JSON.stringify([{ id: "fixture", source: `${short} base` }]),
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

async function allProblems(repository: string): Promise<string[]> {
  return [
    ...(await citationProblems(repository)),
    ...(await linkProblems(repository)),
    ...rowProblems(repository),
    ...(await gateProblems(repository)),
  ];
}

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
      `docs/standards/guide.md:7: [0123456] cites ${absent}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.`,
    ],
  ],
  [
    "an inline commit link outside HEAD's history or this repository",
    (files: Record<string, string>) => {
      files["docs/standards/guide.md"] =
        `${files["docs/standards/guide.md"] ?? ""}\nSee [0123456](${commitPage}${absent}).\nSee [0123456](https://github.com/owner/other/commit/${absent}).\n`;
    },
    [
      `docs/standards/guide.md:10: [0123456] cites ${absent}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.`,
      `docs/standards/guide.md:11: [0123456] links https://github.com/owner/other/commit/${absent}, which is not a commit page of this repository. Link ${commitPage}<full sha>.`,
    ],
  ],
  [
    "a skill anchor no heading gives",
    (files: Record<string, string>) => {
      files[".agents/skills/fixture/SKILL.md"] =
        "---\nname: fixture\n---\n\n[checks](../../../AGENTS.md#check)\n";
    },
    [
      ".agents/skills/fixture/SKILL.md:5: link ../../../AGENTS.md#check names #check, which no heading in AGENTS.md gives. Use one of: #fixture, #checks.",
      ".claude/skills/fixture/SKILL.md:5: link ../../../AGENTS.md#check names #check, which no heading in AGENTS.md gives. Use one of: #fixture, #checks.",
    ],
  ],
  [
    "a row whose gate is gone",
    (files: Record<string, string>) => {
      files["package.json"] = '{"scripts":{}}';
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names script `faults`, which package.json does not define as a script. Restore the gate, or fix the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row with no guide and no gate note",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace("](#gated)", "]");
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" has no guide and no gate note. Link its guide in the Guide cell, or link a heading under ## Gate notes from its Gates cell.',
      'CODING_STANDARDS.md: row "Gated rule" needs two distinct witnesses in its guide or gate note, and has 0. Cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
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
      'CODING_STANDARDS.md: row "Gated rule" names lint `repository/rule`, which no config in eslint.config.mjs turns on for a file in the repository. Restore the gate, or fix the row\'s Gates cell and mark it Review only if no gate remains.',
      'CODING_STANDARDS.md: row "Gated rule" names job `faults`, which no workflow in .github/workflows/ that runs on pull_request defines as a job. Restore the gate, or fix the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row whose fault record is gone",
    (files: Record<string, string>) => {
      files[manifest] = "[]";
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names fault `fixture`, which no record in tests/faults/manifest.json has as its id. Restore the gate, or fix the row\'s Gates cell and mark it Review only if no gate remains.',
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
      'CODING_STANDARDS.md: row "Gated rule" names lint `repository/rule`, which no config in eslint.config.mjs turns on for a file in the repository. Restore the gate, or fix the row\'s Gates cell and mark it Review only if no gate remains.',
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
      'CODING_STANDARDS.md: row "Gated rule" names lint `repository/rule`, which no config in eslint.config.mjs turns on for a file in the repository. Restore the gate, or fix the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a row whose job runs only outside pull requests",
    (files: Record<string, string>) => {
      files[".github/workflows/ci.yml"] =
        "on:\n  workflow_dispatch:\n  push:\n    branches: [main]\njobs:\n  faults:\n    runs-on: x\n";
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" names job `faults`, which no workflow in .github/workflows/ that runs on pull_request defines as a job. Restore the gate, or fix the row\'s Gates cell and mark it Review only if no gate remains.',
    ],
  ],
  [
    "a Partial row that names no gate",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace(
        "[script `faults`, lint `repository/rule`, job `faults`, fault `fixture`](#gated)",
        "[Gated](#gated)",
      );
    },
    [
      'CODING_STANDARDS.md: row "Gated rule" is Partial but names no gate. Name each gate in the Gates cell as script, lint, job or fault with its id, or mark the row Review only.',
    ],
  ],
  [
    "a Review only row that names a gate",
    (files: Record<string, string>) => {
      files[standards] = (files[standards] ?? "").replace(
        "| Guided rule | Review only | None |",
        "| Guided rule | Review only | job `faults` |",
      );
    },
    [
      'CODING_STANDARDS.md: row "Guided rule" is Review only but names a gate. Mark it Partial, or set its Gates cell to None.',
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
      'CODING_STANDARDS.md: row "Guided rule" has Today "Planned". Use Review only or Partial.',
    ],
  ],
])(
  "%s fails, naming the file and the fix",
  async (_fault, change, expected) => {
    expect(await allProblems(fixture(change))).toEqual(expected);
  },
);

test.each([
  [
    "a commit link to another repository",
    (files: Record<string, string>) => {
      files["docs/standards/guide.md"] = (
        files["docs/standards/guide.md"] ?? ""
      ).replace(commitPage, "https://github.com/owner/other/commit/");
    },
    (sha: string) => [
      `docs/standards/guide.md:7: [${sha.slice(0, 7)}] links https://github.com/owner/other/commit/${sha}, which is not a commit page of this repository. Link ${commitPage}<full sha>.`,
      `CODING_STANDARDS.md: row "Guided rule" needs two distinct witnesses in its guide or gate note, and has 1. Cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.`,
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
      `CODING_STANDARDS.md:16: [${sha.slice(0, 7)}] links https://gitlab.com/nathanvale/bun-typescript-template/-/commit/${sha}, which is not a commit page of this repository. Link ${commitPage}<full sha>.`,
      `CODING_STANDARDS.md: row "Gated rule" needs two distinct witnesses in its guide or gate note, and has 1. Cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.`,
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
      'CODING_STANDARDS.md: row "Guided rule" needs two distinct witnesses in its guide or gate note, and has 1. Cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
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
      `CODING_STANDARDS.md:19: names commit ${absent.slice(0, 12)}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.`,
      `docs/standards/guide.md:10: names commit ${absent}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.`,
    ],
  ],
  [
    "a fault record whose source is not an ancestor or names no commit",
    (files: Record<string, string>, sha: string) => {
      files["tests/faults/manifest.json"] = JSON.stringify([
        { id: "fixture", source: `${sha.slice(0, 7)} fix: kept` },
        { id: "lost", source: `${absent.slice(0, 7)} fix: lost` },
        { id: "bare", source: "fix: no commit" },
      ]);
    },
    () => [
      `tests/faults/manifest.json: record "lost" names source ${absent.slice(0, 7)}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.`,
      'tests/faults/manifest.json: record "bare" has source "fix: no commit", which does not start with its fix commit\'s SHA. Write "<short sha> <subject>", as bun run faults:add does.',
    ],
  ],
])(
  "%s fails, naming the commit and the fix",
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
      `CODING_STANDARDS.md:16: [${sha.slice(0, 7)}] links ${commitPage}${sha}, which is not a commit page of this repository. Link ${kernelWeb}/commit/<full sha>.`,
      `docs/standards/guide.md:7: [${sha.slice(0, 7)}] links ${commitPage}${sha}, which is not a commit page of this repository. Link ${kernelWeb}/commit/<full sha>.`,
      'CODING_STANDARDS.md: row "Gated rule" needs two distinct witnesses in its guide or gate note, and has 0. Cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
      'CODING_STANDARDS.md: row "Guided rule" needs two distinct witnesses in its guide or gate note, and has 0. Cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.',
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
    `docs/standards/guide.md:10: [0123456] cites ${absent}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.`,
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
    ".claude/skills/other resolves to .agents/skills/fixture, not .agents/skills/other. Run: rm .claude/skills/other && ln -s ../../.agents/skills/other .claude/skills/other",
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
    `CODING_STANDARDS.md:16: [${sha?.slice(0, 7)}] cites ${sha}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA. ${fetch}`,
    `docs/standards/guide.md:7: [${sha?.slice(0, 7)}] cites ${sha}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA. ${fetch}`,
    `tests/faults/manifest.json: record "fixture" names source ${sha?.slice(0, 7)}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA. ${fetch}`,
  ]);
});
