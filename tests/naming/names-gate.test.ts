import { afterAll, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { processWatchdog } from "../support/process.ts";
import {
  emptyFolder,
  fixtureTree,
  git,
  hookCommands,
  removeFixtureTrees,
  repository,
  runHook,
  write,
} from "./fixture-tree.ts";

const claudeSettings = ".claude/settings.json";
const silent = { stdout: "", stderr: "", exit: 0 };
const fixtureGlossaryRefuses = {
  mutationNotes:
    'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Rename it with the glossary word.',
  allowlistFolder:
    'src/allowlist uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Rename it with the glossary word.',
};

afterAll(removeFixtureTrees);

async function gitTree(): Promise<string> {
  const tree = fixtureTree();
  await git(tree, "init", "--quiet", "--initial-branch=main");
  return tree;
}

function writeCall(filePath: string, cwd: string) {
  return {
    session_id: "fixture",
    transcript_path: join(cwd, "transcript.jsonl"),
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "notes\n" },
    tool_use_id: "toolu_fixture",
  };
}

function beforeWrite(tree: string, filePath: string, cwd = tree) {
  const [command = ""] = hookCommands(tree, claudeSettings, "Write");
  return runHook(command, writeCall(filePath, cwd), {
    cwd,
    projectFolder: tree,
  });
}

test("NG.live Claude Code runs an executable names gate before each Write", () => {
  const [command = ""] = hookCommands(repository, claudeSettings, "Write");
  const script = /\.claude\/hooks\/[\w-]+\.sh/.exec(command)?.[0] ?? "";
  expect(script).toBe(".claude/hooks/names-gate.sh");
  expect(statSync(join(repository, script)).mode & 0o111).not.toBe(0);
});

test(
  "NG.a a new file whose name is refused stops the Write with exit 2 and the problem line",
  async () => {
    const tree = await gitTree();
    expect(
      await beforeWrite(tree, join(tree, "docs/mutation-notes.md")),
    ).toEqual({
      stdout: "",
      stderr: `${fixtureGlossaryRefuses.mutationNotes}\n`,
      exit: 2,
    });
  },
  processWatchdog(2),
);

test(
  "a Write to a file that already exists is an edit, and passes in silence",
  async () => {
    const tree = await gitTree();
    write(tree, "docs/mutation-notes.md", "notes\n");
    expect(
      await beforeWrite(tree, join(tree, "docs/mutation-notes.md")),
    ).toEqual(silent);
  },
  processWatchdog(2),
);

test(
  "a new file with a clean name passes in silence",
  async () => {
    const tree = await gitTree();
    expect(
      await beforeWrite(tree, join(tree, "docs/planted-fault-notes.md")),
    ).toEqual(silent);
  },
  processWatchdog(2),
);

test(
  "a new file in a tree with no names check is outside the repository, and passes in silence",
  async () => {
    const tree = await gitTree();
    const elsewhere = emptyFolder();
    await git(elsewhere, "init", "--quiet", "--initial-branch=main");
    expect(
      await beforeWrite(tree, join(elsewhere, "docs/mutation-notes.md")),
    ).toEqual(silent);
  },
  processWatchdog(3),
);

test(
  "NG.b a new folder on the path is judged, and a folder that exists is not",
  async () => {
    const tree = await gitTree();
    mkdirSync(join(tree, "docs/proof"), { recursive: true });
    expect(
      await beforeWrite(tree, join(tree, "docs/proof/planted-fault-notes.md")),
    ).toEqual(silent);
    expect(
      await beforeWrite(tree, join(tree, "src/allowlist/index.ts")),
    ).toEqual({
      stdout: "",
      stderr: `${fixtureGlossaryRefuses.allowlistFolder}\n`,
      exit: 2,
    });
  },
  processWatchdog(3),
);

test(
  "NG.c a tool call the gate cannot read goes ahead with exit 1 and a notice",
  async () => {
    const tree = await gitTree();
    const [command = ""] = hookCommands(tree, claudeSettings, "Write");
    const call = { tool_name: "Bash", tool_input: { command: "ls" } };
    expect(
      await runHook(command, call, { cwd: tree, projectFolder: tree }),
    ).toEqual({
      stdout: "",
      stderr: [
        "--tool-call cannot read a Bash call. It reads the file_path of a Write call. Wire the names gate to that tool only.",
        "names-gate: check:names --tool-call exited 2, so the names this tool call creates went unchecked. Fix the cause above, or run bun run check:names <path> yourself.",
        "",
      ].join("\n"),
      exit: 1,
    });
  },
  processWatchdog(2),
);

test(
  "NG.d from a nested folder of a git worktree, a new file is judged by the glossary of the tree that owns it",
  async () => {
    const main = await gitTree();
    await git(main, "add", "--", ".");
    await git(main, "commit", "--quiet", "-m", "base");
    await git(main, "worktree", "add", "--quiet", ".worktrees/other");
    const other = join(main, ".worktrees/other");
    write(
      other,
      "GLOSSARY.md",
      "**Fixture**:\nA made-up input.\n_Avoid_: specimen\n",
    );
    mkdirSync(join(other, "docs"));
    const nowhere = join(emptyFolder(), "missing");
    const [command = ""] = hookCommands(other, claudeSettings, "Write");
    const from = { cwd: join(other, "docs"), projectFolder: nowhere };
    expect(
      await runHook(
        command,
        writeCall(join(other, "docs/mutation-notes.md"), from.cwd),
        from,
      ),
    ).toEqual(silent);
    expect(
      await runHook(
        command,
        writeCall(join(other, "docs/specimen.md"), from.cwd),
        from,
      ),
    ).toEqual({
      stdout: "",
      stderr:
        'docs/specimen.md uses "specimen", which GLOSSARY.md lists under Avoid for "Fixture". Rename it with the glossary word.\n',
      exit: 2,
    });
    expect(
      await beforeWrite(main, join(other, "docs/specimen.md")),
    ).toMatchObject({ exit: 2 });
  },
  processWatchdog(7),
);
