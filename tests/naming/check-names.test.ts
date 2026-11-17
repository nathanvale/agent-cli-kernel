import { afterAll, expect, test } from "bun:test";
import { processWatchdog } from "../support/process.ts";
import { checkNames, fixtureTree, removeFixtureTrees } from "./fixture-tree.ts";

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
