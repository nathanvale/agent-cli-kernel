import { expect, test } from "bun:test";
import {
  type Ancestry,
  commitLinkProblems,
  lineOf,
  notAncestor,
} from "../../support/commit-links.ts";

const web = "https://github.com/owner/repo";
const origin = "https://github.com/owner/origin";
const page = `${web}/commit/`;
const reachable = "0123456789abcdef0123456789abcdef01234567";
const otherReachable = "fedcba9876543210fedcba9876543210fedcba98";
const unreachable = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const file = "guide.md";

function historyOf(fetch = ""): Ancestry {
  return {
    page,
    pages: [page, `${origin}/commit/`],
    isThread: () => false,
    isAncestor: (sha) => sha === reachable || sha === otherReachable,
    fetch,
  };
}

function problemsOf(text: string, fetch = ""): string[] {
  return commitLinkProblems(file, text, historyOf(fetch)).problems;
}

function definedOf(text: string): string[] {
  return [...commitLinkProblems(file, text, historyOf()).defined];
}

test("a definition whose label starts its reachable commit's SHA is clean and defined", () => {
  const result = commitLinkProblems(
    file,
    `[0123456]: ${page}${reachable}\n`,
    historyOf(),
  );
  expect(result.problems).toEqual([]);
  expect([...result.defined]).toEqual(["0123456"]);
});

test("an inline link to a reachable commit is clean and defines nothing", () => {
  const result = commitLinkProblems(
    file,
    `See [0123456](${page}${reachable}).\n`,
    historyOf(),
  );
  expect(result.problems).toEqual([]);
  expect([...result.defined]).toEqual([]);
});

test("a commit page of the second citable origin is accepted", () => {
  expect(problemsOf(`[fedcba9]: ${origin}/commit/${otherReachable}\n`)).toEqual(
    [],
  );
});

test("a link whose label is no SHA and whose target is no commit page is not checked", () => {
  const text = "[docs]: https://example.com/guide\nSee [docs](other.md).\n";
  expect(problemsOf(text)).toEqual([]);
  expect(definedOf(text)).toEqual([]);
});

test("a six-character hex label is no SHA, so a target with no commit page is not checked", () => {
  expect(problemsOf("[abc123]: https://example.com/guide\n")).toEqual([]);
});

test("a seven-character hex label is a SHA, so a target with no commit page is refused", () => {
  expect(problemsOf("[abc1234]: https://example.com/guide\n")).toEqual([
    `${file}:1: [abc1234] links https://example.com/guide, which is not a commit page of this repository. Repair: link ${page}<full sha>.`,
  ]);
  expect(definedOf("[abc1234]: https://example.com/guide\n")).toEqual([
    "abc1234",
  ]);
});

test.each([
  ["starts with other text", "v0123456"],
  ["ends with other text", "0123456z"],
  ["is a hex run over forty characters", `${reachable}0`],
])(
  "a label that %s is no SHA, so a target with no commit page is not checked",
  (_name, label) => {
    expect(problemsOf(`[${label}]: https://example.com/guide\n`)).toEqual([]);
  },
);

test("a definition needs no space between its colon and its target", () => {
  expect(definedOf(`[0123456]:${page}${reachable}\n`)).toEqual(["0123456"]);
  expect(problemsOf(`[aaaaaaa]:${page}${unreachable}\n`)).toHaveLength(1);
});

test("a forty-character hex label is a SHA that must start the linked commit's SHA", () => {
  expect(problemsOf(`[${reachable}]: ${page}${reachable}\n`)).toEqual([]);
  expect(problemsOf(`[${reachable}]: ${page}${otherReachable}\n`)).toEqual([
    `${file}:1: [${reachable}] links commit ${otherReachable}. Repair: make the label the start of that SHA.`,
  ]);
});

test("a label that is no SHA, linked to a commit page, is checked for ancestry", () => {
  expect(problemsOf(`[witness]: ${page}${reachable}\n`)).toEqual([]);
  expect(problemsOf(`[witness]: ${page}${unreachable}\n`)).toEqual([
    `${file}:1: [witness] cites ${unreachable}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
  ]);
  expect(definedOf(`[witness]: ${page}${unreachable}\n`)).toEqual(["witness"]);
});

test("a label that starts a different commit's SHA is refused", () => {
  expect(problemsOf(`[fedcba9]: ${page}${reachable}\n`)).toEqual([
    `${file}:1: [fedcba9] links commit ${reachable}. Repair: make the label the start of that SHA.`,
  ]);
});

test("a commit page of another repository is refused", () => {
  const foreign = `https://github.com/owner/other/commit/${reachable}`;
  expect(problemsOf(`[0123456]: ${foreign}\n`)).toEqual([
    `${file}:1: [0123456] links ${foreign}, which is not a commit page of this repository. Repair: link ${page}<full sha>.`,
  ]);
});

test.each([
  ["thirty-nine-character", reachable.slice(0, 39)],
  ["forty-one-character", `${reachable}0`],
  ["uppercase", reachable.toUpperCase()],
  ["missing", ""],
])("a commit page ending in a %s SHA is refused", (_name, sha) => {
  const target = `${page}${sha}`;
  expect(problemsOf(`[0123456](${target})\n`)).toEqual([
    `${file}:1: [0123456] links ${target}, which is not a commit page of this repository. Repair: link ${page}<full sha>.`,
  ]);
});

test("a commit outside HEAD's history is refused, and the fetch hint follows the repair", () => {
  const hint = " Run `git fetch --unshallow` and rerun.";
  expect(problemsOf(`[aaaaaaa]: ${page}${unreachable}\n`, hint)).toEqual([
    `${file}:1: [aaaaaaa] cites ${unreachable}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.${hint}`,
  ]);
});

test("a definition indented three spaces is read, and one indented four spaces is not", () => {
  expect(problemsOf(`   [aaaaaaa]: ${page}${unreachable}\n`)).toHaveLength(1);
  expect(definedOf(`   [0123456]: ${page}${reachable}\n`)).toEqual(["0123456"]);
  expect(problemsOf(`    [aaaaaaa]: ${page}${unreachable}\n`)).toEqual([]);
  expect(definedOf(`    [0123456]: ${page}${reachable}\n`)).toEqual([]);
});

test("each problem names its own line, definitions before inline links", () => {
  const text = [
    "intro",
    `See [aaaaaaa](${page}${unreachable}).`,
    "",
    `[fedcba9]: ${page}${reachable}`,
    `[0123456]: ${page}${reachable}`,
  ].join("\n");
  expect(problemsOf(text)).toEqual([
    `${file}:4: [fedcba9] links commit ${reachable}. Repair: make the label the start of that SHA.`,
    `${file}:2: [aaaaaaa] cites ${unreachable}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA.`,
  ]);
});

test("text with no link has no problems and defines nothing", () => {
  const result = commitLinkProblems(file, "plain prose\n", historyOf());
  expect(result.problems).toEqual([]);
  expect([...result.defined]).toEqual([]);
});

test("lineOf counts the line an index falls on, from one", () => {
  const text = "one\ntwo\nthree";
  expect(lineOf(text, 0)).toBe(1);
  expect(lineOf(text, 3)).toBe(1);
  expect(lineOf(text, 4)).toBe(2);
  expect(lineOf(text, text.indexOf("three"))).toBe(3);
});

test("notAncestor names the SHA, the repair and the fetch hint", () => {
  expect(notAncestor(unreachable, historyOf(" Fetch."))).toBe(
    `${unreachable}, which is not an ancestor of HEAD. Repair: cite a commit in this branch's history, or correct the SHA. Fetch.`,
  );
});
