import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import { write } from "../../support/fixture-files.ts";
import { gitEnv, gitOutput, inherited } from "../../support/git-fixture.ts";
import { treeFiles } from "../../support/lint-rule-folder.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { typecheckTree } from "../kernel-repair/harness.ts";
import {
  exampleDocument,
  exampleDocumentPath,
  skillFolder,
  writeCommand,
} from "./example-document.ts";
import { exampleFiles, packageName, repository } from "./example-files.ts";

const treeBound = 120_000;
const installBound = 120_000;
const example = exampleFiles();
const folders: string[] = [];
let built: Promise<string> | undefined;

afterAll(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

function ownedFolder(prefix: string): string {
  const folder = testFolder(prefix);
  folders.push(folder);
  return folder;
}

async function build(tree: string): Promise<string> {
  for (const [path, text] of example) write(tree, path, text);
  const modules = join(tree, "node_modules");
  await mkdir(modules);
  for (const name of await readdir(join(repository, "node_modules")))
    await symlink(join(repository, "node_modules", name), join(modules, name));
  await symlink(repository, join(modules, packageName));
  await writeFile(
    join(tree, "tsconfig.json"),
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
  );
  await writeFile(
    join(tree, "eslint.config.mjs"),
    [
      `import { kernelLint } from "${packageName}/lint";`,
      "export default kernelLint({",
      "  rootDir: import.meta.dirname,",
      '  srcDir: "src",',
      '  testDirs: ["tests"],',
      "  addons: [],",
      "});",
      "",
    ].join("\n"),
  );
  return tree;
}

function consumer(): Promise<string> {
  built ??= build(ownedFolder("kernel-author-guide-"));
  return built;
}

function skillDocuments(folder = skillFolder): string[] {
  return treeFiles("**/*.md", folder).map((path) => join(folder, path));
}

type Block = {
  readonly document: string;
  readonly line: number;
  readonly language: string;
  readonly lines: readonly string[];
};

function codeBlocks(path: string): Block[] {
  const blocks: Block[] = [];
  let open:
    | { fence: string; language: string; line: number; lines: string[] }
    | undefined;
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((text, index) => {
      const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/.exec(text);
      const marker = fence?.[1] ?? "";
      if (open) {
        const closes =
          marker.startsWith(open.fence[0] ?? "") &&
          marker.length >= open.fence.length &&
          fence?.[2] === "";
        if (!closes) {
          open.lines.push(text);
          return;
        }
        blocks.push({
          document: relative(skillFolder, path),
          language: open.language,
          line: open.line,
          lines: open.lines,
        });
        open = undefined;
        return;
      }
      if (fence)
        open = {
          fence: marker,
          language: fence[2] ?? "",
          line: index + 1,
          lines: [],
        };
    });
  if (open)
    throw new Error(
      `${relative(skillFolder, path)}:${String(open.line)}: this code block never closes.`,
    );
  return blocks;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function heldBy(file: string, block: readonly string[]): boolean {
  if (block.every((line) => line.trim() === "")) return false;
  const lines = file.split("\n");
  const first = block[0] ?? "";
  return lines.some((line, start) => {
    const shift = indentOf(line) - indentOf(first);
    return (
      shift >= 0 &&
      block.every((wanted, offset) => {
        const found = lines[start + offset];
        return wanted === ""
          ? found === ""
          : found === `${" ".repeat(shift)}${wanted}`;
      })
    );
  });
}

function brokenLinks(folder: string): string[] {
  return skillDocuments(folder).flatMap((path) =>
    [
      ...readFileSync(path, "utf8").matchAll(
        /\]\(([^()\s#]+)(?:#[^()\s]*)?\)|^@(\S+)$/gm,
      ),
    ]
      .map((match) => match[1] ?? match[2] ?? "")
      .filter((target) => !/^[a-z]+:/.test(target))
      .map((target) => resolve(dirname(path), target))
      .filter(
        (target) =>
          !target.startsWith(`${folder}/`) ||
          !existsSync(target) ||
          !statSync(target).isFile(),
      )
      .map((target) => `${relative(folder, path)} -> ${target}`),
  );
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "nothing was thrown";
}

describe("the author guide's example, laid out as a repository that depends on the kernel package", () => {
  test(
    "it compiles under the repository's compiler settings",
    async () => {
      const run = await typecheckTree(await consumer());
      expect({ exit: run.exit, output: run.stdout + run.stderr }).toEqual({
        exit: 0,
        output: "",
      });
    },
    treeBound,
  );

  test(
    "the kernel's lint, loaded from the package, reads every example file and reports nothing",
    async () => {
      const tree = await consumer();
      const results = await new ESLint({ cwd: tree }).lintFiles(["."]);
      const read = results.map((result) => relative(tree, result.filePath));
      for (const path of example.keys()) expect(read).toContain(path);
      expect(
        results.flatMap((result) =>
          result.messages.map(
            (message) =>
              `${relative(tree, result.filePath)}:${String(message.line)} ${String(message.ruleId)} ${message.message}`,
          ),
        ),
      ).toEqual([]);
    },
    treeBound,
  );

  test(
    "its own tests pass, in process and through its real entry file",
    async () => {
      const run = await spawnBounded([process.execPath, "test"], {
        cwd: await consumer(),
        boundMilliseconds: treeBound - 10_000,
      });
      const summary = `${run.stdout}\n${run.stderr}`;
      expect({
        exit: run.exit,
        ran: / [1-9][0-9]* pass\n/.test(summary),
        failed: / 0 fail\n/.test(summary),
        files: summary.includes(" across 2 files."),
      }).toEqual({ exit: 0, ran: true, failed: true, files: true });
    },
    treeBound,
  );

  test(
    "references/example.md's transcript is what the example prints",
    async () => {
      const tree = await consumer();
      const transcripts = codeBlocks(exampleDocumentPath).filter(
        (block) => block.language === "text",
      );
      expect(transcripts.length).toBe(1);
      const printed: string[] = [];
      for (const line of transcripts[0]?.lines ?? []) {
        if (!line.startsWith("$ ")) continue;
        const [runner, ...argv] = line.slice(2).split(" ");
        expect(runner).toBe("bun");
        const run = await spawnBounded([process.execPath, ...argv], {
          cwd: tree,
        });
        printed.push(
          line,
          ...`${run.stdout}${run.stderr}`.trimEnd().split("\n"),
        );
      }
      expect(printed.filter((line) => line.startsWith("$ ")).length).toBe(3);
      expect(printed).toEqual([...(transcripts[0]?.lines ?? [])]);
    },
    treeBound,
  );
});

describe("the kernel package, installed by git ref", () => {
  test(
    `a git-ref install of this checkout's HEAD carries the skill at node_modules/${packageName}/skills/${packageName}/: every file there at HEAD, unchanged, and every file its documents link`,
    async () => {
      const head = gitOutput(repository, "rev-parse", "HEAD").trim();
      const skillPath = relative(repository, skillFolder);
      const shipped = gitOutput(
        repository,
        "ls-tree",
        "-r",
        "--name-only",
        head,
        "--",
        skillPath,
      )
        .split("\n")
        .filter((path) => path !== "");
      expect(shipped).toContain(`${skillPath}/SKILL.md`);
      const folder = ownedFolder("kernel-author-guide-install-");
      await writeFile(
        join(folder, "package.json"),
        JSON.stringify({
          name: "skill-install",
          private: true,
          type: "module",
          dependencies: { [packageName]: `git+file://${repository}#${head}` },
        }),
      );
      await writeFile(
        join(folder, "bunfig.toml"),
        '[install]\nauto = "disable"\n',
      );
      const installed = await spawnBounded([process.execPath, "install"], {
        cwd: folder,
        env: { ...inherited(), ...gitEnv },
        boundMilliseconds: installBound - 10_000,
      });
      expect({
        exit: installed.exit,
        output: installed.exit === 0 ? "" : installed.stdout + installed.stderr,
      }).toEqual({ exit: 0, output: "" });
      const installedPackage = join(folder, "node_modules", packageName);
      expect(
        shipped.filter(
          (path) =>
            !existsSync(join(installedPackage, path)) ||
            readFileSync(join(installedPackage, path), "utf8") !==
              gitOutput(repository, "show", `${head}:${path}`),
        ),
      ).toEqual([]);
      expect(brokenLinks(join(installedPackage, skillPath))).toEqual([]);
    },
    installBound,
  );
});

describe("the author skill's documents, shipped in the kernel package", () => {
  test(`references/example.md shows each example file whole, as ${writeCommand} writes it`, () => {
    const current = readFileSync(exampleDocumentPath, "utf8");
    expect(current).toBe(exampleDocument(current, example));
  });

  test("references/example.md is refused when it has a section for a file the example lacks, or none for one it has", () => {
    const files = new Map([["src/a.ts", "const a = 1;\n"]]);
    const block = (path: string) => `## \`${path}\`\n\n\`\`\`ts\n\`\`\`\n`;
    expect(thrownMessage(() => exampleDocument(block("src/b.ts"), files))).toBe(
      "references/example.md has a section for src/b.ts, which is no example file. Repair: name one of src/a.ts, or delete the section.",
    );
    expect(thrownMessage(() => exampleDocument("# Example\n", files))).toBe(
      "references/example.md shows no example file. Repair: give it exactly one section for each of src/a.ts. A section is a heading of the form ## `<path>`, a blank line, then a ts code block.",
    );
    expect(exampleDocument(block("src/a.ts"), files)).toBe(
      "## `src/a.ts`\n\n```ts\nconst a = 1;\n```\n",
    );
  });

  test("an example file stored without the .txt ending is refused", () => {
    const folder = ownedFolder("kernel-author-guide-example-");
    write(folder, "src/a.ts.txt", "const a = 1;\n");
    expect([...exampleFiles(folder).keys()]).toEqual(["src/a.ts"]);
    write(folder, "src/b.ts", "const b = 2;\n");
    expect(thrownMessage(() => exampleFiles(folder))).toBe(
      "src/b.ts is in the example folder without the .txt ending. Repair: store each example file as <path in a repository that depends on the kernel>.txt.",
    );
  });

  test("every ts block in every skill document is copied from an example file", () => {
    const blocks = skillDocuments()
      .flatMap(codeBlocks)
      .filter((block) => block.language === "ts");
    expect(blocks.length).toBeGreaterThan(example.size);
    expect(
      blocks
        .filter(
          (block) =>
            ![...example.values()].some((file) => heldBy(file, block.lines)),
        )
        .map(
          (block) =>
            `${block.document}:${String(block.line)}: this ts block is in no example file. Repair: copy the lines again from tests/kernel/author-guide/example, or change the example and run ${writeCommand}.`,
        ),
    ).toEqual([]);
  });

  test("a code block that never closes is refused, so its lines cannot escape the checks", () => {
    const folder = ownedFolder("kernel-author-guide-fence-");
    const path = join(folder, "unclosed.md");
    write(folder, "unclosed.md", "# Guide\n\n```ts\nconst stale = 1;\n");
    expect(thrownMessage(() => codeBlocks(path))).toBe(
      `${relative(skillFolder, path)}:3: this code block never closes.`,
    );
  });

  test("tilde and longer fences are read as code blocks, so their lines cannot escape the checks", () => {
    const folder = ownedFolder("kernel-author-guide-fence-");
    const read = (name: string, text: string) => {
      write(folder, name, text);
      return codeBlocks(join(folder, name)).map((block) => [
        block.language,
        ...block.lines,
      ]);
    };
    expect(read("tilde.md", "~~~ts\nconst stale = 1;\n~~~\n")).toEqual([
      ["ts", "const stale = 1;"],
    ]);
    expect(
      read("long.md", "````text\n```ts\nconst inner = 1;\n```\n````\n"),
    ).toEqual([["text", "```ts", "const inner = 1;", "```"]]);
    expect(
      read("mixed.md", "```ts\nconst a = 1;\n~~~\nconst b = 2;\n```\n"),
    ).toEqual([["ts", "const a = 1;", "~~~", "const b = 2;"]]);
  });

  test("a ts block with no code is held by no example file, so it cannot pass as copied", () => {
    const file = [...example.values()][0] ?? "";
    expect(heldBy(file, [])).toBe(false);
    expect(heldBy(file, ["", ""])).toBe(false);
    expect(heldBy(file, file.split("\n").slice(0, 2))).toBe(true);
  });

  test("every code block names its language, so none escapes the two checks above", () => {
    expect(
      skillDocuments()
        .flatMap(codeBlocks)
        .filter((block) => block.language !== "ts" && block.language !== "text")
        .map((block) => `${block.document}:${String(block.line)}`),
    ).toEqual([]);
    expect(
      skillDocuments()
        .filter((path) => path !== exampleDocumentPath)
        .flatMap(codeBlocks)
        .filter((block) => block.language === "text")
        .map((block) => `${block.document}:${String(block.line)}`),
    ).toEqual([]);
  });

  test("every local link in a skill document names a file, not a folder, inside the skill's folder", () => {
    expect(
      skillDocuments()
        .map((path) => relative(skillFolder, path))
        .sort(),
    ).toEqual([
      "SKILL.md",
      "references/commands.md",
      "references/example.md",
      "references/stations.md",
      "references/testing.md",
    ]);
    expect(brokenLinks(skillFolder)).toEqual([]);
    const folder = ownedFolder("kernel-author-guide-links-");
    write(folder, "SKILL.md", "[a folder](references)\n");
    write(folder, "references/x.md", "# X\n");
    expect(brokenLinks(folder)).toEqual([
      `SKILL.md -> ${join(folder, "references")}`,
    ]);
  });
});
