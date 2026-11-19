import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import * as kernel from "../../../kernel/src/kernel/index.ts";
import { write } from "../../support/fixture-files.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { typecheckTree } from "../kernel-repair/harness.ts";
import {
  emptyInput,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
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

describe("kernel behaviour the author guide states in words", () => {
  function reader(
    refusal = { repairAction: "Repair the input.", text: "Run it again." },
    words = { trigger: "The read ran.", summary: "Read.", message: "Read." },
  ) {
    return kernel.contractFor({
      cli: "guide",
      commands: [
        kernel.command({
          identity: "guide.read",
          route: ["read"],
          summary: words.summary,
          input: emptyInput,
          capabilities: {},
          stations: [
            kernel.station(kernel.commonCauses, {
              ...stationWords,
              commandIdentity: "guide.read",
              causeCode: "SUCCESS_UNCHANGED",
              trigger: words.trigger,
              repairAction: null,
              guidance: { next: { kind: "done" } },
              independentObservable: "guide.read:ran",
            }),
            kernel.station(kernel.commonCauses, {
              ...stationWords,
              commandIdentity: "guide.read",
              causeCode: "DOMAIN_PRECONDITION_UNMET",
              trigger: "The read was refused.",
              repairAction: refusal.repairAction,
              guidance: { next: { kind: "instruction", text: refusal.text } },
              independentObservable: "guide.read:refused",
            }),
          ],
          run: (_input, context) =>
            context.result(
              { commandIdentity: "guide.read", causeCode: "SUCCESS_UNCHANGED" },
              { message: words.message, data: null, effects: unchanged },
            ),
        }),
      ],
    });
  }

  test("commands.md: the kernel exports no empty input", () => {
    expect(Object.keys(kernel)).not.toContain("emptyInput");
    expect(Object.keys(kernel)).toContain("commonCauses");
  });

  test("stations.md: a brace that is no template token, in a repair action or in guidance text, throws at start-up and names no station", () => {
    const message = "Invalid run binding placement or guidance template token.";
    expect(() =>
      reader({ repairAction: "Pass {name}.", text: "Run it again." }),
    ).toThrow(message);
    expect(() =>
      reader({ repairAction: "Pass a name.", text: "Send {name}." }),
    ).toThrow(message);
    expect(() =>
      reader({ repairAction: "Close the } first.", text: "Run it again." }),
    ).toThrow("Malformed guidance template token.");
    expect(message).not.toContain("guide.read");
  });

  test("stations.md: a template token in a repair action, and a brace in a trigger, a summary or a message, are accepted", async () => {
    const contract = reader(
      { repairAction: "Inspect run {runId}.", text: "Run it again." },
      {
        trigger: "The read ran {here}.",
        summary: "Read {anything}.",
        message: "Read {this}.",
      },
    );
    expect(await kernel.runInProcess(contract)(["read"])).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: { message: "Read {this}." },
    });
  });

  test("commands.md: <command> --help is refused with exit code 2, and --discover-command prints that command's input", async () => {
    const run = kernel.runInProcess(reader());
    expect(await run(["read", "--help"])).toMatchObject({
      kind: "envelope",
      exitCode: 2,
      envelope: { result: { causeCode: "USAGE_INVALID_INVOCATION" } },
    });
    expect(await run(["--discover-command", "guide.read"])).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: { result: { data: { input: emptyInput } } },
    });
  });

  test("commands.md: an option's value is the next word, and the same value after an equals sign is a usage refusal", async () => {
    const count = kernel.command({
      identity: "guide.count",
      route: ["count"],
      summary: "Count.",
      input: {
        ...emptyInput,
        options: [
          {
            name: "--to",
            aliases: [],
            summary: "Where to stop.",
            required: true,
            repeatable: false,
            value: { kind: "integer", minimum: 0, maximum: 9 },
          },
        ],
      },
      capabilities: {},
      run: (input, context) =>
        context.result(
          { commandIdentity: "guide.count", causeCode: "SUCCESS_UNCHANGED" },
          { message: "Counted.", data: input["--to"], effects: unchanged },
        ),
    });
    const run = kernel.runInProcess(
      kernel.contractFor({ cli: "guide", commands: [count] }),
    );
    expect(await run(["count", "--to", "3"])).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: { result: { data: 3 } },
    });
    expect(await run(["count", "--to=3"])).toMatchObject({
      kind: "envelope",
      exitCode: 2,
      envelope: { result: { causeCode: "USAGE_INVALID_INVOCATION" } },
    });
  });
});
