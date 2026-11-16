import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
type Gate = { kind: "script" | "lint" | "job"; id: string };

// Front matter and fenced code are not links a reader follows, so they are
// blanked; blanking keeps the line numbers the problems report.
function prose(path: string): string {
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

function headings(text: string): { level: number; slug: string }[] {
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
  const slugs = headings(prose(resolved)).map(({ slug }) => slug);
  return slugs.includes(anchor)
    ? undefined
    : `link ${target} names #${anchor}, which no heading in ${shown} gives. Use one of: ${slugs.map((slug) => `#${slug}`).join(", ")}.`;
}

async function linkProblems(repository: string): Promise<string[]> {
  const problems: string[] = [];
  for (const view of await matching(repository, agentFiles)) {
    const text = prose(join(repository, view));
    for (const { target, line } of links(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const problem = linkProblem(repository, view, target);
      if (problem !== undefined) problems.push(`${view}:${line}: ${problem}`);
    }
  }
  const skills = join(repository, ".agents/skills");
  const skillNames = existsSync(skills) ? readdirSync(skills) : [];
  for (const skill of skillNames)
    if (!existsSync(join(repository, ".claude/skills", skill, "SKILL.md")))
      problems.push(
        `.agents/skills/${skill} has no Claude Code link. Run: ln -s ../../.agents/skills/${skill} .claude/skills/${skill}`,
      );
  return problems;
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

async function citationProblems(repository: string): Promise<string[]> {
  const history = git(repository, ["rev-list", "HEAD"]).split("\n");
  const graft = resolve(
    repository,
    git(repository, ["rev-parse", "--git-path", "shallow"]),
  );
  const cut = existsSync(graft) ? readFileSync(graft, "utf8").split("\n") : [];
  const fetch = history.some((sha) => cut.includes(sha))
    ? " HEAD's history is cut short in this shallow clone: run `git fetch --unshallow` and rerun."
    : "";
  const problems: string[] = [];
  const files = await matching(repository, [standards, "docs/standards/*.md"]);
  for (const file of files) {
    const text = prose(join(repository, file));
    const defined = new Set<string>();
    for (const match of text.matchAll(
      /^ {0,3}\[([^\]]+)\]:\s*\S*\/commit\/([0-9a-f]{7,40})\b/gm,
    )) {
      const [, label = "", sha = ""] = match;
      const where = `${file}:${lineOf(text, match.index)}`;
      defined.add(label);
      if (/^[0-9a-f]{7,40}$/.test(label) && !sha.startsWith(label))
        problems.push(
          `${where}: [${label}] links commit ${sha}. Make the label the start of that SHA.`,
        );
      if (!history.some((each) => each.startsWith(sha)))
        problems.push(
          `${where}: [${label}] cites ${sha}, which is not an ancestor of HEAD. Cite a commit in this branch's history, or fix the SHA.${fetch}`,
        );
    }
    for (const match of text.matchAll(/\[([0-9a-f]{7,40})\](?![[(:])/g)) {
      const [, label = ""] = match;
      if (!defined.has(label))
        problems.push(
          `${file}:${lineOf(text, match.index)}: [${label}] has no commit link. Add [${label}]: https://github.com/<owner>/<repo>/commit/<full sha> at the end of the file.`,
        );
    }
  }
  return problems;
}

function ruleTable(repository: string): {
  rows: Row[];
  gateNotes: string[];
  problems: string[];
} {
  const text = prose(join(repository, standards));
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
      `${standards}: the rule table has no ${name} column. Restore it, since the standards test and the repo-steward skill read it.`,
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
  return [...row.gates.matchAll(/\b(script|lint|job) `([^`]+)`/g)].map(
    ([, kind, id]) => ({ kind: kind as Gate["kind"], id: id ?? "" }),
  );
}

function rowProblems(repository: string): string[] {
  const { rows, gateNotes, problems } = ruleTable(repository);
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
    const named = gatesOf(row).length > 0;
    if (row.today === "Partial" && !named)
      problems.push(
        `${where} is Partial but names no gate. Name each gate in the Gates cell as script, lint or job with its id, or mark the row Review only.`,
      );
    else if (row.today === "Review only" && named)
      problems.push(
        `${where} is Review only but names a gate. Mark it Partial, or set its Gates cell to None.`,
      );
    else if (row.today !== "Partial" && row.today !== "Review only")
      problems.push(
        `${where} has Today "${row.today}". Use Review only or Partial.`,
      );
  }
  return problems;
}

async function lintIds(repository: string): Promise<Set<string>> {
  const url = pathToFileURL(join(repository, "eslint.config.mjs")).href;
  const { default: configs } = (await import(url)) as {
    default: { rules?: Record<string, unknown> }[];
  };
  const off = (setting: unknown) => {
    const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
    return severity === 0 || severity === "off";
  };
  return new Set(
    configs.flatMap((config) =>
      Object.entries(config.rules ?? {})
        .filter(([, setting]) => !off(setting))
        .map(([id]) => id),
    ),
  );
}

async function jobIds(repository: string): Promise<Set<string>> {
  const files = await matching(repository, [".github/workflows/*.{yml,yaml}"]);
  const jobs = await Promise.all(
    files.map(async (file) => {
      const document = Bun.YAML.parse(
        await Bun.file(join(repository, file)).text(),
      ) as { jobs?: Record<string, unknown> } | null;
      return Object.keys(document?.jobs ?? {});
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
      owner: "no config in eslint.config.mjs turns on",
    },
    job: {
      ids: await jobIds(repository),
      owner: "no workflow in .github/workflows/ defines as a job",
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
    "eslint.config.mjs":
      'export default [{ rules: { "repository/rule": "error" } }];\n',
    ".github/workflows/ci.yml":
      "jobs:\n  faults:\n    runs-on: ubuntu-latest\n",
    "AGENTS.md": "# Fixture\n\n## Checks\n",
    [standards]: [
      "# Coding Standards",
      "",
      "## Rule table",
      "",
      "| Rule | Today | Gates | Guide |",
      "| --- | --- | --- | --- |",
      "| Gated rule | Partial | [script `faults`, lint `repository/rule`, job `faults`](#gated) | None |",
      "| Guided rule | Review only | None | [Guide](docs/standards/guide.md#lesson) |",
      "",
      "## Gate notes",
      "",
      "### Gated",
      "",
      `- Witnessed: [${short}].`,
      "",
      `[${short}]: https://github.com/owner/repo/commit/${sha}`,
      "",
    ].join("\n"),
    "docs/standards/guide.md": `# Guide\n\n## Lesson\n\n- Witnessed: [${short}].\n\n[${short}]: https://github.com/owner/repo/commit/${sha}\n`,
    ".agents/skills/fixture/SKILL.md":
      "---\nname: fixture\n---\n\n[checks](../../../AGENTS.md#checks)\n",
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
    ],
  ],
])(
  "%s fails, naming the file and the fix",
  async (_fault, change, expected) => {
    expect(await allProblems(fixture(change))).toEqual(expected);
  },
);

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
  ]);
});
