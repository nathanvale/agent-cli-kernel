import { afterEach, expect, test } from "bun:test";
import { renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFileSizeCheck } from "../../../scripts/check-file-size.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  fixtureRepository,
  git,
  gitOutcome,
  removeFixtureTrees,
  repository,
  runInFixture,
  write,
} from "../naming/fixture-tree.ts";

// Interface: independent boundary oracle. Each repetition is one o200k_base token.
const atLimit = " x".repeat(5_000);
const overLimit = " x".repeat(5_001);
const glossary = "tests/template/glossary/glossary.test.ts";
const integration = "starters/complex/tests/integration/integration.test.ts";
const standing = "tests/planted-faults/fault-records.json";
const note = "docs/file-size.txt";
const noteRefusal =
  'check:file-size: "docs/file-size.txt": 5001 tokens exceeds the 5000-token limit. Repair: shorten or split the file.\n';

const hookRefusal = `check:file-size: scanned 1 staged UTF-8 text files (limit 5000 tokens).\n${noteRefusal}`;

afterEach(removeFixtureTrees);

function checkFileSize(tree: string, ...args: string[]) {
  return runInFixture(
    [process.execPath, "run", "--silent", "check:file-size", ...args],
    tree,
  );
}

function checkInProcess(tree: string, args: readonly string[] = []) {
  const previous = process.env;
  process.env = { ...inherited(), ...gitEnv };
  try {
    return runFileSizeCheck(args, tree);
  } finally {
    process.env = previous;
  }
}

async function seed(tree: string, files: Readonly<Record<string, string>>) {
  for (const [path, content] of Object.entries(files))
    write(tree, path, content);
  await git(tree, "add", "--", ...Object.keys(files));
}

function linkToolchain(tree: string) {
  symlinkSync(join(repository, "node_modules"), join(tree, "node_modules"));
}

async function treeWithHook() {
  const tree = await fixtureRepository();
  await seed(tree, { [note]: "original" });
  await git(tree, "commit", "--quiet", "-m", "seed");
  linkToolchain(tree);
  await git(tree, "config", "core.hooksPath", ".githooks");
  return tree;
}

test(
  "the package command passes 5000 tokens and refuses 5001",
  async () => {
    const tree = await fixtureRepository();
    linkToolchain(tree);
    await seed(tree, {
      [glossary]: overLimit,
      [integration]: overLimit,
      [note]: atLimit,
    });
    write(tree, "docs/untracked.txt", overLimit);

    const admitted = await checkFileSize(tree);
    expect(admitted).toMatchObject({ exit: 0, stderr: "" });
    expect(admitted.stdout).toContain(
      "check:file-size: scanned 5 tracked UTF-8 text files (limit 5000 tokens).\n",
    );

    write(tree, note, overLimit);
    const refused = await checkFileSize(tree);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toBe(noteRefusal);
  },
  processWatchdog(7),
);

test(
  "pre-commit counts staged bytes in a partially staged file",
  async () => {
    const tree = await treeWithHook();
    await seed(tree, { [note]: overLimit });
    write(tree, note, atLimit);

    const refused = await gitOutcome(
      tree,
      "commit",
      "--quiet",
      "-m",
      "oversized",
    );
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toBe(hookRefusal);
    expect(await gitOutcome(tree, "show", `:${note}`)).toMatchObject({
      exit: 0,
      stdout: overLimit,
    });
    expect(await gitOutcome(tree, "show", `HEAD:${note}`)).toMatchObject({
      exit: 0,
      stdout: "original",
    });

    await git(tree, "add", "--", note);
    write(tree, note, overLimit);
    await git(tree, "commit", "--quiet", "-m", "within limit");
    expect(await gitOutcome(tree, "show", `HEAD:${note}`)).toMatchObject({
      exit: 0,
      stdout: atLimit,
    });
    expect(await Bun.file(join(tree, note)).text()).toBe(overLimit);
  },
  processWatchdog(15),
);

test(
  "pre-commit refuses oversized bytes from the active alternate index",
  async () => {
    const tree = await treeWithHook();
    const env = { GIT_INDEX_FILE: join(tree, ".git", "other-index") };
    const gitInIndex = (...args: string[]) =>
      runInFixture(["git", ...args], tree, env);
    expect(await gitInIndex("read-tree", "HEAD")).toMatchObject({ exit: 0 });
    write(tree, note, overLimit);
    expect(await gitInIndex("add", "--", note)).toMatchObject({ exit: 0 });
    write(tree, note, "original");

    const refused = await gitInIndex("commit", "--quiet", "-m", "oversized");
    expect(refused).toMatchObject({ exit: 1, stderr: hookRefusal });
    expect(await gitInIndex("show", `:${note}`)).toMatchObject({
      exit: 0,
      stdout: overLimit,
    });
    expect(await gitOutcome(tree, "show", `:${note}`)).toMatchObject({
      exit: 0,
      stdout: "original",
    });
  },
  processWatchdog(13),
);

test(
  "the scan skips excluded files, binary bytes and symlinks and reports exact-path recorded hits",
  async () => {
    const tree = await fixtureRepository();
    const nearby = "docs/fault-records.json";
    await seed(tree, {
      [glossary]: overLimit,
      [integration]: overLimit,
      [standing]: " x",
      [nearby]: overLimit,
      "kernel/notes.txt": overLimit,
      "tests/kernel/notes.txt": overLimit,
      "tools/oxlint/anti-slop/vendor/notes.txt": overLimit,
      "starters/complex/bun.lock": overLimit,
      ".claude/hooks/fallow-gate.sh": overLimit,
      ".codex/hooks/fallow-gate.sh": overLimit,
      "docs/binary.txt": `\0${overLimit}`,
      "docs/not-utf8.txt": overLimit,
      "docs/linked.txt": overLimit,
    });
    const malformed = join(tree, "docs/not-utf8.txt");
    writeFileSync(
      malformed,
      Buffer.concat([Buffer.from([255]), Buffer.from(overLimit)]),
    );
    const linked = join(tree, "docs/linked.txt");
    unlinkSync(linked);
    symlinkSync("fault-records.json", linked);

    const result = checkInProcess(tree);
    expect(result).toMatchObject({
      code: 1,
      stderr:
        'check:file-size: "docs/fault-records.json": 5001 tokens exceeds the 5000-token limit. Repair: shorten or split the file.\n',
    });
    expect(result.stdout).toContain(
      "check:file-size: scanned 6 tracked UTF-8 text files (limit 5000 tokens).\n",
    );
    expect(result.stdout).toContain(
      `"${glossary}": 5001 tokens (limit 5000), temporary recorded hit.`,
    );
    expect(result.stdout).toContain(
      `"${integration}": 5001 tokens (limit 5000), temporary recorded hit.`,
    );
    expect(result.stdout).toContain(
      `"${standing}": 1 tokens (limit 5000), standing recorded hit.`,
    );
  },
  processWatchdog(5),
);

test(
  "a temporary recorded hit must leave when its tracked text shrinks or disappears",
  async () => {
    const tree = await fixtureRepository();
    write(tree, integration, overLimit);
    await seed(tree, { [glossary]: atLimit });

    expect(checkInProcess(tree)).toMatchObject({
      code: 1,
      stderr: [
        `check:file-size: "${glossary}": stale temporary recorded hit (5000 tokens, limit 5000). Repair: remove its entry from scripts/check-file-size.ts.`,
        `check:file-size: "${integration}": stale temporary recorded hit (no tracked UTF-8 text, limit 5000). Repair: remove its entry from scripts/check-file-size.ts.`,
        "",
      ].join("\n"),
    });

    write(tree, glossary, "\0");
    const nonText = checkInProcess(tree);
    expect(nonText.code).toBe(1);
    expect(nonText.stderr).toContain(
      `"${glossary}": stale temporary recorded hit (no tracked UTF-8 text, limit 5000).`,
    );
  },
  processWatchdog(5),
);

test(
  "a staged rename of a temporary recorded hit refuses the old record and the new oversized path",
  async () => {
    const tree = await fixtureRepository();
    await seed(tree, { [glossary]: overLimit, [integration]: overLimit });
    await git(tree, "commit", "--quiet", "-m", "seed");
    const untouched = checkInProcess(tree, ["--staged"]);
    expect(untouched).toEqual({
      code: 0,
      stdout:
        "check:file-size: scanned 0 staged UTF-8 text files (limit 5000 tokens).\n",
      stderr: "",
    });

    const renamed = "docs/glossary-test.txt";
    write(tree, renamed, "");
    renameSync(join(tree, glossary), join(tree, renamed));
    await git(tree, "add", "--", glossary, renamed);
    const result = checkInProcess(tree, ["--staged"]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim().split("\n").sort()).toEqual([
      `check:file-size: "${renamed}": 5001 tokens exceeds the 5000-token limit. Repair: shorten or split the file.`,
      `check:file-size: "${glossary}": stale temporary recorded hit (no tracked UTF-8 text, limit 5000). Repair: remove its entry from scripts/check-file-size.ts.`,
    ]);
  },
  processWatchdog(8),
);

test(
  "the staged scan skips a removed file and a symlink to oversized text",
  async () => {
    const tree = await fixtureRepository();
    await seed(tree, { [note]: overLimit });
    await git(tree, "commit", "--quiet", "-m", "seed");
    await git(tree, "rm", "--quiet", "--", note);
    write(tree, note, overLimit);
    const link = "docs/link.txt";
    symlinkSync("file-size.txt", join(tree, link));
    await git(tree, "add", "--", link);

    expect(checkInProcess(tree, ["--staged"])).toEqual({
      code: 0,
      stdout:
        "check:file-size: scanned 0 staged UTF-8 text files (limit 5000 tokens).\n",
      stderr: "",
    });
  },
  processWatchdog(8),
);

test(
  "a working tree with no tracked texts cannot pass the scan",
  async () => {
    const tree = await fixtureRepository();
    await git(
      tree,
      "rm",
      "--quiet",
      "GLOSSARY.md",
      "tests/template/naming/recorded-hits.json",
    );

    const result = checkInProcess(tree);
    expect(result).toMatchObject({
      code: 1,
      stdout:
        "check:file-size: scanned 0 tracked UTF-8 text files (limit 5000 tokens).\n",
    });
    expect(result.stderr).toContain(
      "check:file-size: no tracked UTF-8 text files to scan. Repair: run the gate in a populated template checkout.\n",
    );
  },
  processWatchdog(5),
);
