import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import { write } from "../../support/fixture-files.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { typecheckTree } from "../kernel-repair/harness.ts";
import {
  exampleDocument,
  exampleDocumentPath,
  guideFolder,
  writeCommand,
} from "./example-document.ts";
import { exampleFiles, repository } from "./example-files.ts";

const kernelSource = join(repository, "kernel");
const baseRoots = ["src/kernel", "config/kernel"];
const treeBound = 120_000;
const example = exampleFiles();

let built: Promise<string> | undefined;

afterAll(async () => {
  if (built) await rm(await built, { recursive: true, force: true });
});

async function build(): Promise<string> {
  const tree = testFolder("kernel-author-guide-");
  for (const root of baseRoots)
    await cp(join(kernelSource, root), join(tree, root), { recursive: true });
  for (const [path, text] of example) write(tree, path, text);
  await symlink(join(repository, "node_modules"), join(tree, "node_modules"));
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
      'import { kernelLint } from "./config/kernel/eslint.mjs";',
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

function generatedRepository(): Promise<string> {
  built ??= build();
  return built;
}

function guideDocuments(folder = guideFolder): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return guideDocuments(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

type Block = {
  readonly document: string;
  readonly line: number;
  readonly language: string;
  readonly lines: readonly string[];
};

function codeBlocks(path: string): Block[] {
  const blocks: Block[] = [];
  let open: { language: string; line: number; lines: string[] } | undefined;
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((text, index) => {
      const fence = /^```(\S*)$/.exec(text);
      if (!fence) {
        open?.lines.push(text);
        return;
      }
      if (open) {
        blocks.push({ document: relative(guideFolder, path), ...open });
        open = undefined;
        return;
      }
      open = { language: fence[1] ?? "", line: index + 1, lines: [] };
    });
  return blocks;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function heldBy(file: string, block: readonly string[]): boolean {
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

describe("the author guide's example, built as a generated repository with the base stamp roots", () => {
  test("the base stamp roots it copies are the ones kernel-declaration.json names", () => {
    const declaration: unknown = JSON.parse(
      readFileSync(
        join(kernelSource, "config/kernel/kernel-declaration.json"),
        "utf8",
      ),
    );
    expect(declaration).toMatchObject({ base: { roots: baseRoots } });
  });

  test(
    "it compiles under the repository's compiler settings",
    async () => {
      const run = await typecheckTree(await generatedRepository());
      expect({ exit: run.exit, output: run.stdout + run.stderr }).toEqual({
        exit: 0,
        output: "",
      });
    },
    treeBound,
  );

  test(
    "the stamped lint reads every example file and reports nothing",
    async () => {
      const tree = await generatedRepository();
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
        cwd: await generatedRepository(),
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
    "docs/example.md's transcript is what the example prints",
    async () => {
      const tree = await generatedRepository();
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

describe("the author guide's documents, stamped with the kernel", () => {
  test(`docs/example.md shows each example file whole, as ${writeCommand} writes it`, () => {
    const current = readFileSync(exampleDocumentPath, "utf8");
    expect(current).toBe(exampleDocument(current, example));
  });

  test("every ts block in every guide document is copied from an example file", () => {
    const blocks = guideDocuments()
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

  test("every code block names its language, so none escapes the two checks above", () => {
    expect(
      guideDocuments()
        .flatMap(codeBlocks)
        .filter((block) => block.language !== "ts" && block.language !== "text")
        .map((block) => `${block.document}:${String(block.line)}`),
    ).toEqual([]);
    expect(
      guideDocuments()
        .filter((path) => path !== exampleDocumentPath)
        .flatMap(codeBlocks)
        .filter((block) => block.language === "text")
        .map((block) => `${block.document}:${String(block.line)}`),
    ).toEqual([]);
  });

  test("every local link in a guide document names a file inside the stamp root", () => {
    const documents = guideDocuments();
    expect(documents.map((path) => relative(guideFolder, path)).sort()).toEqual(
      [
        "AGENTS.md",
        "docs/commands.md",
        "docs/example.md",
        "docs/stations.md",
        "docs/testing.md",
      ],
    );
    const broken = documents.flatMap((path) =>
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
            !existsSync(target) || !target.startsWith(`${guideFolder}/`),
        )
        .map((target) => `${relative(guideFolder, path)} -> ${target}`),
    );
    expect(broken).toEqual([]);
  });
});
