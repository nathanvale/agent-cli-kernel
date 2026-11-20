import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import * as kernel from "../../../kernel/src/kernel/index.ts";
import { write } from "../../support/fixture-files.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { treeFiles } from "../../support/lint-rule-folder.ts";
import { testFolder } from "../../support/test-folder.ts";
import { typecheckTree } from "../kernel-repair/harness.ts";
import { spawnBounded } from "../kernel-repair/swarm-process.ts";
import {
  emptyInput,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import {
  exampleDocument,
  exampleDocumentPath,
  skillFolder,
  writeCommand,
} from "./example-document.ts";
import { exampleFiles, packageName, repository } from "./example-files.ts";

const exampleBound = 130_000;
const installBound = 90_000;
const gitBound = 10_000;
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

function exampleTree(): Promise<string> {
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

function blobId(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`)
    .update(bytes)
    .digest("hex");
}

function skillBlocks(): Block[] {
  return skillDocuments().flatMap(codeBlocks);
}

function uncopiedBlocks(
  blocks: readonly Block[],
  files: ReadonlyMap<string, string>,
): string[] {
  return blocks
    .filter(
      (block) =>
        block.language === "ts" &&
        ![...files.values()].some((file) => heldBy(file, block.lines)),
    )
    .map(
      (block) =>
        `${block.document}:${String(block.line)}: this ts block is in no example file. Repair: copy the lines again from tests/kernel/author-guide/example, or change the example and run ${writeCommand}.`,
    );
}

const transcriptDocument = "references/example.md";

function unlabelledBlocks(blocks: readonly Block[]): string[] {
  return blocks
    .filter(
      (block) =>
        block.language !== "ts" &&
        !(block.language === "text" && block.document === transcriptDocument),
    )
    .map(
      (block) =>
        `${block.document}:${String(block.line)}: this code block is neither ts nor the transcript in ${transcriptDocument}, so no check reads it. Repair: label it ts and copy it from the example.`,
    );
}

function xmlText(text: string): string {
  return text
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("the author guide's example, laid out as a repository that depends on the kernel package", () => {
  test(
    "it compiles under the repository's compiler settings",
    async () => {
      const run = await typecheckTree(await exampleTree());
      expect({ exit: run.exit, output: run.stdout + run.stderr }).toEqual({
        exit: 0,
        output: "",
      });
    },
    exampleBound,
  );

  test(
    "the kernel's lint, loaded from the package, reads every example file and reports nothing",
    async () => {
      const tree = await exampleTree();
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
    exampleBound,
  );

  test(
    "its own tests all pass, each by name, in process and through its real entry file",
    async () => {
      const tree = await exampleTree();
      const report = join(tree, "junit.xml");
      const run = await spawnBounded(
        [
          process.execPath,
          "test",
          "--reporter=junit",
          `--reporter-outfile=${report}`,
        ],
        { cwd: tree, boundMilliseconds: exampleBound - 10_000 },
      );
      expect(run.exit).toBe(0);
      const passed = [
        ...readFileSync(report, "utf8").matchAll(
          /<testcase name="([^"]*)"[^>]* file="([^"]*)"[^>]* assertions="[1-9][0-9]*" \/>/g,
        ),
      ]
        .map(([, name = "", file = ""]) => `${file}: ${xmlText(name)}`)
        .sort();
      const declared = [...example]
        .filter(([path]) => path.startsWith("tests/"))
        .flatMap(([path, text]) =>
          [...text.matchAll(/^test\(\s*"([^"]+)"/gm)].map(
            ([, title = ""]) => `${path}: ${title}`,
          ),
        )
        .sort();
      expect(
        declared.filter((entry) => entry.startsWith("tests/cli.test.ts: "))
          .length,
      ).toBeGreaterThan(0);
      expect(passed).toEqual(declared);
    },
    exampleBound,
  );

  test(
    "references/example.md's transcript is what the example prints",
    async () => {
      const tree = await exampleTree();
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
    exampleBound,
  );
});

describe("the kernel package, installed by git ref", () => {
  test(
    `a git-ref install of this checkout's HEAD carries the skill at node_modules/${packageName}/skills/${packageName}/: every file there at HEAD, unchanged, and every file its documents link`,
    async () => {
      const git = (...args: string[]) =>
        spawnBounded(["git", ...args], {
          cwd: repository,
          env: { ...inherited(), ...gitEnv },
          boundMilliseconds: gitBound,
        });
      const revision = await git("rev-parse", "HEAD");
      expect(revision.exit).toBe(0);
      const head = revision.stdout.trim();
      const skillPath = relative(repository, skillFolder);
      const tree = await git("ls-tree", "-r", head, "--", skillPath);
      expect(tree.exit).toBe(0);
      const shipped = tree.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [, blob = "", path = ""] =
            /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line) ?? [];
          return { blob, path };
        });
      expect(shipped.map(({ path }) => path)).toContain(
        `${skillPath}/SKILL.md`,
      );
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
        boundMilliseconds: installBound,
      });
      expect({
        exit: installed.exit,
        output: installed.exit === 0 ? "" : installed.stdout + installed.stderr,
      }).toEqual({ exit: 0, output: "" });
      const installedPackage = join(folder, "node_modules", packageName);
      expect(
        shipped
          .filter(
            ({ blob, path }) =>
              !existsSync(join(installedPackage, path)) ||
              blobId(readFileSync(join(installedPackage, path))) !== blob,
          )
          .map(({ path }) => path),
      ).toEqual([]);
      expect(brokenLinks(join(installedPackage, skillPath))).toEqual([]);
    },
    installBound + 2 * gitBound + 10_000,
  );
});

describe("the author skill's documents, shipped in the kernel package", () => {
  test(`references/example.md shows each example file whole, as ${writeCommand} writes it`, () => {
    const current = readFileSync(exampleDocumentPath, "utf8");
    expect(current).toBe(exampleDocument(current, example));
  });

  test("references/example.md is refused when it has a section for a file the example lacks, misses one it has, or repeats one", () => {
    const files = new Map([["src/a.ts", "const a = 1;\n"]]);
    const two = new Map([...files, ["src/b.ts", "const b = 2;\n"]]);
    const block = (path: string) => `## \`${path}\`\n\n\`\`\`ts\n\`\`\`\n`;
    const shape =
      "A section is a heading of the form ## `<path>`, a blank line, then a ts code block.";
    expect(() => exampleDocument(block("src/b.ts"), files)).toThrow(
      new Error(
        "references/example.md has a section for src/b.ts, which is no example file. Repair: name one of src/a.ts, or delete the section.",
      ),
    );
    expect(() => exampleDocument("# Example\n", files)).toThrow(
      new Error(
        `references/example.md shows no example file. Repair: give it exactly one section for each of src/a.ts. ${shape}`,
      ),
    );
    expect(() => exampleDocument(block("src/a.ts"), two)).toThrow(
      new Error(
        `references/example.md shows src/a.ts. Repair: give it exactly one section for each of src/a.ts, src/b.ts. ${shape}`,
      ),
    );
    expect(() =>
      exampleDocument(`${block("src/a.ts")}\n${block("src/a.ts")}`, files),
    ).toThrow(
      new Error(
        `references/example.md shows src/a.ts, src/a.ts. Repair: give it exactly one section for each of src/a.ts. ${shape}`,
      ),
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
    expect(() => exampleFiles(folder)).toThrow(
      new Error(
        "src/b.ts is in the example folder without the .txt ending. Repair: store each example file as <path in a repository that depends on the kernel>.txt.",
      ),
    );
  });

  test("every ts block in every skill document is copied from an example file, and one that is not is refused", () => {
    const blocks = skillBlocks();
    expect(
      blocks.filter((block) => block.language === "ts").length,
    ).toBeGreaterThan(example.size);
    expect(uncopiedBlocks(blocks, example)).toEqual([]);
    const files = new Map([["src/a.ts", "const a = 1;\nconst b = 2;\n"]]);
    const block = (lines: readonly string[]) => ({
      document: "references/x.md",
      line: 3,
      language: "ts",
      lines,
    });
    expect(
      uncopiedBlocks([block(["const b = 2;"]), block(["const c = 3;"])], files),
    ).toEqual([
      `references/x.md:3: this ts block is in no example file. Repair: copy the lines again from tests/kernel/author-guide/example, or change the example and run ${writeCommand}.`,
    ]);
  });

  test("a code block that never closes is refused, so its lines cannot escape the checks", () => {
    const folder = ownedFolder("kernel-author-guide-fence-");
    const path = join(folder, "unclosed.md");
    write(folder, "unclosed.md", "# Guide\n\n```ts\nconst stale = 1;\n");
    expect(() => codeBlocks(path)).toThrow(
      new Error(
        `${relative(skillFolder, path)}:3: this code block never closes.`,
      ),
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

  test("every code block is ts or the example's transcript, so none escapes the checks above, and any other is refused", () => {
    expect(unlabelledBlocks(skillBlocks())).toEqual([]);
    const block = (document: string, language: string) => ({
      document,
      line: 5,
      language,
      lines: ["x"],
    });
    expect(
      unlabelledBlocks([
        block("references/commands.md", ""),
        block("references/commands.md", "text"),
        block(transcriptDocument, "text"),
        block("SKILL.md", "ts"),
      ]),
    ).toEqual(
      ["", "text"].map(
        () =>
          `references/commands.md:5: this code block is neither ts nor the transcript in ${transcriptDocument}, so no check reads it. Repair: label it ts and copy it from the example.`,
      ),
    );
  });

  test("SKILL.md's frontmatter parses as YAML, names the skill as its folder does, and describes it", () => {
    const text = readFileSync(join(skillFolder, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    expect(typeof frontmatter).toBe("string");
    const parsed: unknown = Bun.YAML.parse(frontmatter ?? "");
    const fields = typeof parsed === "object" && parsed !== null ? parsed : {};
    const description: unknown = Reflect.get(fields, "description");
    expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
    expect(Reflect.get(fields, "name")).toBe(packageName);
    expect(
      typeof description === "string" && description.includes(packageName),
    ).toBe(true);
    expect(basename(skillFolder)).toBe(packageName);
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
    const skill = join(folder, "skill");
    write(skill, "SKILL.md", "[a folder](references)\n[outside](../x.md)\n");
    write(skill, "references/x.md", "# X\n");
    write(folder, "x.md", "# Outside\n");
    expect(brokenLinks(skill)).toEqual([
      `SKILL.md -> ${join(skill, "references")}`,
      `SKILL.md -> ${join(folder, "x.md")}`,
    ]);
  });
});

describe("kernel behaviour the author skill states in words", () => {
  const usageRefusal = (message: string) => ({
    kind: "envelope",
    exitCode: 2,
    envelope: { message, result: { causeCode: "USAGE_INVALID_INVOCATION" } },
  });

  function readContract(
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

  test("commands.md: the package exports no empty input", () => {
    expect(Object.keys(kernel)).not.toContain("emptyInput");
    expect(Object.keys(kernel)).toContain("commonCauses");
  });

  test("stations.md: a brace that is no template token, in a repair action or in guidance text, throws at start-up with exactly the message the guide quotes, which names no station", () => {
    const placement =
      "Invalid run binding placement or guidance template token.";
    expect(() =>
      readContract({ repairAction: "Pass {name}.", text: "Run it again." }),
    ).toThrow(new Error(placement));
    expect(() =>
      readContract({ repairAction: "Pass a name.", text: "Send {name}." }),
    ).toThrow(new Error(placement));
    expect(() =>
      readContract({
        repairAction: "Close the } first.",
        text: "Run it again.",
      }),
    ).toThrow(new Error("Malformed guidance template token."));
  });

  test("commands.md and stations.md: add-ons are chosen only in installedAddons, and approval without state throws at start-up with the message the guide quotes", () => {
    expect(() =>
      kernel.contractFor({
        cli: "guide",
        commands: [],
        installedAddons: ["approval"],
      }),
    ).toThrow(
      new Error(
        "Approval requires the state add-on: list state in installedAddons and pass the add-on made by contractFor.stateAddon.",
      ),
    );
    expect(readContract().cli).toBe("guide");
  });

  test("stations.md: a template token in a repair action, and a brace in a trigger, a summary or a message, are accepted", async () => {
    const contract = readContract(
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

  test("commands.md: <command> --help answers with exit code 0 and that command's discovery, as --discover-command does", async () => {
    const run = kernel.runInProcess(readContract());
    const help = await run(["read", "--help"]);
    expect(help).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        result: {
          commandIdentity: "guide.command-discovery",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            command: { commandIdentity: "guide.read" },
            input: emptyInput,
          },
        },
      },
    });
    const discovered = await run(["--discover-command", "guide.read"]);
    expect(help.kind === "envelope" && help.envelope.result.data).toEqual(
      discovered.kind === "envelope" && discovered.envelope.result.data,
    );
  });

  test("commands.md: a usage refusal is exit code 2 and its message names what was wrong: an option the command does not declare, or a missing argument", async () => {
    expect(
      await kernel.runInProcess(readContract())(["read", "--wat"]),
    ).toMatchObject(
      usageRefusal(
        "The invocation uses an option this command does not declare.",
      ),
    );
    const show = kernel.command({
      identity: "guide.show",
      route: ["show"],
      summary: "Show.",
      input: {
        ...emptyInput,
        arguments: [
          {
            name: "planet",
            summary: "The planet.",
            required: true,
            value: {
              kind: "string",
              minLength: 1,
              maxLength: 9,
              choices: null,
              pattern: null,
            },
          },
        ],
      },
      capabilities: {},
      run: (input, context) =>
        context.result(
          { commandIdentity: "guide.show", causeCode: "SUCCESS_UNCHANGED" },
          { message: input.planet, data: null, effects: unchanged },
        ),
    });
    const run = kernel.runInProcess(
      kernel.contractFor({ cli: "guide", commands: [show] }),
    );
    expect(await run(["show", "mars"])).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: { message: "mars" },
    });
    expect(await run(["show"])).toMatchObject(
      usageRefusal("The required argument planet is missing."),
    );
  });

  test("commands.md: an option's value is the next word, and the same value after an equals sign is refused as an undeclared option", async () => {
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
            required: false,
            repeatable: false,
            value: { kind: "integer", minimum: 0, maximum: 9 },
          },
        ],
      },
      capabilities: {},
      run: (input, context) =>
        context.result(
          { commandIdentity: "guide.count", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Counted.",
            data: input["--to"] ?? null,
            effects: unchanged,
          },
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
    expect(await run(["count", "--to=3"])).toMatchObject(
      usageRefusal(
        "The invocation uses an option this command does not declare.",
      ),
    );
  });
});
