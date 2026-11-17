import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { recordedHitsFile } from "../../scripts/glossary.ts";
import { processWatchdog } from "../support/process.ts";
import {
  checkNames,
  fixtureTree,
  git,
  removeFixtureTrees,
  write,
} from "./fixture-tree.ts";

const usage = "Usage: bun run check:names <path> [path ...] | --staged";

afterAll(removeFixtureTrees);

test.each([
  [
    "an Avoid word",
    "docs/mutation-notes.md",
    'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Rename it with the glossary word.',
  ],
  [
    "a qualify word alone",
    "src/host.ts",
    'src/host.ts uses "host" with no qualifier. Add a word that says which host it is.',
  ],
])(
  "CN.a a name that uses %s is refused with its word and its repair",
  async (_kind, path, line) => {
    expect(await checkNames(fixtureTree(), [path])).toEqual({
      stdout: "",
      stderr: `${line}\n`,
      exit: 1,
    });
  },
  processWatchdog(1),
);

test(
  "names that use only glossary words pass in silence",
  async () => {
    expect(
      await checkNames(fixtureTree(), [
        "docs/planted-fault-notes.md",
        "src/test-host.ts",
      ]),
    ).toEqual({ stdout: "", stderr: "", exit: 0 });
  },
  processWatchdog(1),
);

test(
  "a recorded hit passes",
  async () => {
    const tree = fixtureTree([
      { path: "proofs", word: "proof", reason: "fixture" },
    ]);
    expect(await checkNames(tree, ["proofs"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  },
  processWatchdog(1),
);

test(
  "a recorded hit that no longer occurs is left to the tracked names check",
  async () => {
    const tree = fixtureTree([
      { path: "src/host.ts", word: "host", reason: "fixture" },
    ]);
    expect(await checkNames(tree, ["src/test-host.ts"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  },
  processWatchdog(1),
);

test(
  "CN.b every folder on a given path is judged once, by its own name",
  async () => {
    expect(
      await checkNames(fixtureTree(), [
        "src/allowlist/proof/index.ts",
        "src/allowlist/other.ts",
      ]),
    ).toEqual({
      stdout: "",
      stderr: [
        'src/allowlist uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Rename it with the glossary word.',
        'src/allowlist/proof uses "proof" with no qualifier. Add a word that says which proof it is.',
        "",
      ].join("\n"),
      exit: 1,
    });
  },
  processWatchdog(1),
);

test(
  "CN.c --staged judges an added and a renamed name, and ignores a modified one",
  async () => {
    const tree = fixtureTree();
    const body = "A file long enough for git to see its move as a rename.\n";
    await git(tree, "init", "--quiet", "--initial-branch=main");
    write(tree, "docs/mutation-notes.md", "before\n");
    write(tree, "docs/planted-fault-notes.md", body);
    await git(tree, "add", "--", "docs");
    await git(tree, "commit", "--quiet", "-m", "base");
    write(tree, "docs/mutation-notes.md", "after\n");
    await git(tree, "add", "--", "docs");
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
    await git(tree, "mv", "docs/planted-fault-notes.md", "docs/host.md");
    write(tree, "src/allowlist.ts", "");
    await git(tree, "add", "--", "src");
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr: [
        'docs/host.md uses "host" with no qualifier. Add a word that says which host it is.',
        'src/allowlist.ts uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Rename it with the glossary word.',
        "",
      ].join("\n"),
      exit: 1,
    });
  },
  processWatchdog(8),
);

test(
  "an absolute path inside the repository is judged by its path from the root",
  async () => {
    const tree = fixtureTree();
    expect(await checkNames(tree, [join(tree, "src/host.ts")])).toEqual({
      stdout: "",
      stderr:
        'src/host.ts uses "host" with no qualifier. Add a word that says which host it is.\n',
      exit: 1,
    });
  },
  processWatchdog(1),
);

test.each([
  ["no path", [], "Give at least one path, or --staged."],
  ["an option it does not know", ["--stagd"], 'Unknown option "--stagd".'],
  [
    "a path beside --staged",
    ["--staged", "src/host.ts"],
    "--staged takes no path.",
  ],
  [
    "a path outside the repository",
    ["../elsewhere/host.ts"],
    "../elsewhere/host.ts is outside this repository.",
  ],
])(
  "CN.d %s is a usage error",
  async (_kind, args, reason) => {
    expect(await checkNames(fixtureTree(), args)).toEqual({
      stdout: "",
      stderr: `${usage}. ${reason}\n`,
      exit: 2,
    });
  },
  processWatchdog(1),
);

test(
  "CN.e a check that cannot run exits 2, so it is not read as a refused name",
  async () => {
    const tree = fixtureTree();
    write(tree, recordedHitsFile, "{}");
    expect(await checkNames(tree, ["src/host.ts"])).toEqual({
      stdout: "",
      stderr: `${recordedHitsFile} needs a "hits" array.\n`,
      exit: 2,
    });
  },
  processWatchdog(1),
);
