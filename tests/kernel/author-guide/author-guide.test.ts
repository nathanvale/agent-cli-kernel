import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import * as kernel from "../../../kernel/src/kernel/index.ts";
import { menuAddon } from "../../../kernel/src/addons/menu/index.ts";
import { runInProcessOn } from "../../../kernel/src/kernel/lifecycle.ts";
import { createStateAddon } from "../../../kernel/src/kernel/state-seam.ts";
import {
  programDetails,
  programsAddon,
} from "../../../kernel/src/addons/programs/index.ts";
import {
  stateAddon,
  supersededQualification,
} from "../../../kernel/src/addons/state/index.ts";
import { write } from "../../support/fixture-files.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { treeFiles } from "../../support/lint-rule-folder.ts";
import { signalGroupIfPresent } from "../../support/signal.ts";
import { testFolder } from "../../support/test-folder.ts";
import { typecheckTree } from "../kernel-repair/harness.ts";
import {
  processWatchdog,
  spawnBounded,
} from "../kernel-repair/swarm-process.ts";
import {
  emptyInput,
  refusedHandoff,
  stationWords,
  unchanged,
} from "../kernel-repair/shapes.ts";
import { goneWithin } from "../lifecycle/harness.ts";
import { recordingHost } from "../lifecycle/recording-host.ts";
import {
  exampleDocument,
  exampleDocumentPath,
  exampleDocuments,
  exampleFilesFor,
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

describe("the author skill's example, laid out as a repository that depends on the kernel package", () => {
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
  test(
    "the example's pending lists nothing for a home never visited, and refuses a state folder it cannot read",
    async () => {
      const tree = await exampleTree();
      const home = ownedFolder("kernel-author-guide-pending-");
      const env = {
        ...process.env,
        MOONS_HOME: home,
        MOONS_OPENER: "/usr/bin/true",
      };
      const run = (...argv: string[]) =>
        spawnBounded([process.execPath, "src/cli.ts", ...argv, "--json"], {
          cwd: tree,
          env,
        });
      const resultOf = (text: string): unknown =>
        Reflect.get(Object(JSON.parse(text)), "result");
      const fresh = await run("pending");
      expect(fresh.exit).toBe(0);
      expect(resultOf(fresh.stdout)).toMatchObject({
        causeCode: "SUCCESS_UNCHANGED",
        data: { unfinished: [] },
      });
      expect((await run("visit", "mars")).exit).toBe(0);
      await mkdir(join(home, "state", "operations", "not-a-case"));
      const refused = await run("pending");
      expect(refused.exit).toBe(3);
      expect(resultOf(refused.stdout)).toMatchObject({
        outcome: "refused",
        causeCode: "DOMAIN_PRECONDITION_UNMET",
        data: null,
      });
      expect(JSON.parse(refused.stdout)).toMatchObject({
        message: "The visits' state is corrupt.",
      });
    },
    processWatchdog(3),
  );

  async function writeStub(
    folder: string,
    name: string,
    body: string,
  ): Promise<string> {
    const script = join(folder, name);
    await writeFile(script, body);
    await chmod(script, 0o755);
    return script;
  }

  function parsedResult(stdout: string): unknown {
    return Reflect.get(Object(JSON.parse(stdout)), "result");
  }

  test(
    "the example's visit leaves a timed-out opener that traps SIGTERM and exits 0 unconfirmed and listed by pending",
    async () => {
      const tree = await exampleTree();
      const home = ownedFolder("kernel-author-guide-timeout-zero-");
      const opener = await writeStub(
        home,
        "timeout-zero.sh",
        [
          "#!/bin/sh",
          "trap 'kill \"$pid\" 2>/dev/null; exit 0' TERM",
          "sleep 60 &",
          "pid=$!",
          'wait "$pid"',
          "",
        ].join("\n"),
      );
      const runWith = (program: string, ...argv: string[]) =>
        spawnBounded([process.execPath, "src/cli.ts", ...argv, "--json"], {
          cwd: tree,
          env: { ...process.env, MOONS_HOME: home, MOONS_OPENER: program },
        });
      const timedOut = await runWith(opener, "visit", "venus");
      expect(timedOut.exit).toBe(3);
      expect(parsedResult(timedOut.stdout)).toMatchObject({
        outcome: "failed",
        causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
        transactionState: "unknown",
        effects: {
          completed: ["planet.record"],
          remaining: [],
          uncertain: ["viewer.launch"],
        },
      });
      const listed = await runWith("/usr/bin/true", "pending");
      expect(listed.exit).toBe(0);
      expect(parsedResult(listed.stdout)).toMatchObject({
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          unfinished: [
            { planet: "venus", effects: ["planet.record", "viewer.launch"] },
          ],
        },
      });
      const blocked = await runWith("/usr/bin/true", "visit", "venus");
      expect(blocked.exit).toBe(3);
      expect(parsedResult(blocked.stdout)).toMatchObject({
        outcome: "refused",
        causeCode: "DOMAIN_MOONS_VISIT_UNRESOLVED",
        transactionState: "unchanged",
      });
    },
    processWatchdog(3),
  );

  test(
    "the example's visit leaves an opener stopped by mid-launch SIGTERM unconfirmed even if it traps SIGTERM and exits 0",
    async () => {
      const tree = await exampleTree();
      const home = ownedFolder("kernel-author-guide-mid-launch-trap-");
      const ready = join(home, "ready");
      const opener = await writeStub(
        home,
        "trap-zero.sh",
        [
          "#!/bin/sh",
          "trap 'kill \"$pid\" 2>/dev/null; exit 0' TERM",
          'printf "ready\\n" > "$MOONS_READY"',
          "sleep 60 &",
          "pid=$!",
          'wait "$pid"',
          "",
        ].join("\n"),
      );
      const stopped = await spawnBounded(
        [process.execPath, "src/cli.ts", "visit", "venus", "--json"],
        {
          cwd: tree,
          env: {
            ...process.env,
            MOONS_HOME: home,
            MOONS_OPENER: opener,
            MOONS_READY: ready,
          },
          signalAt: { ledger: ready, line: "ready", signal: "SIGTERM" },
        },
      );
      expect({
        ready: existsSync(ready),
        exit: stopped.exit,
        stdout: stopped.stdout,
        stderr: stopped.stderr,
      }).toEqual({ ready: true, exit: 143, stdout: "", stderr: "" });
      const checkEnv = {
        ...process.env,
        MOONS_HOME: home,
        MOONS_OPENER: "/usr/bin/true",
      };
      const listed = await spawnBounded(
        [process.execPath, "src/cli.ts", "pending", "--json"],
        { cwd: tree, env: checkEnv },
      );
      expect(listed.exit).toBe(0);
      expect(parsedResult(listed.stdout)).toMatchObject({
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          unfinished: [
            { planet: "venus", effects: ["planet.record", "viewer.launch"] },
          ],
        },
      });
      const blocked = await spawnBounded(
        [process.execPath, "src/cli.ts", "visit", "venus", "--json"],
        { cwd: tree, env: checkEnv },
      );
      expect(blocked.exit).toBe(3);
      expect(parsedResult(blocked.stdout)).toMatchObject({
        outcome: "refused",
        causeCode: "DOMAIN_MOONS_VISIT_UNRESOLVED",
        transactionState: "unchanged",
      });
    },
    processWatchdog(3),
  );

  test(
    "the example's visit leaves a signal-killed opener unconfirmed and listed by pending",
    async () => {
      const tree = await exampleTree();
      const home = ownedFolder("kernel-author-guide-signal-opener-");
      const opener = await writeStub(
        home,
        "self-kill.sh",
        ["#!/bin/sh", "kill -TERM $$", ""].join("\n"),
      );
      const runWith = (program: string, ...argv: string[]) =>
        spawnBounded([process.execPath, "src/cli.ts", ...argv, "--json"], {
          cwd: tree,
          env: { ...process.env, MOONS_HOME: home, MOONS_OPENER: program },
        });
      const killed = await runWith(opener, "visit", "venus");
      expect(killed.exit).toBe(3);
      expect(parsedResult(killed.stdout)).toMatchObject({
        outcome: "failed",
        causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
        transactionState: "unknown",
        effects: {
          completed: ["planet.record"],
          remaining: [],
          uncertain: ["viewer.launch"],
        },
      });
      const listed = await runWith("/usr/bin/true", "pending");
      expect(listed.exit).toBe(0);
      expect(parsedResult(listed.stdout)).toMatchObject({
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          unfinished: [
            { planet: "venus", effects: ["planet.record", "viewer.launch"] },
          ],
        },
      });
    },
    processWatchdog(2),
  );

  test(
    "the example's visit leaves an opener whose termination is not confirmed unconfirmed and listed by pending",
    async () => {
      const tree = await exampleTree();
      const home = ownedFolder("kernel-author-guide-unconfirmed-stop-");
      const probe = join(home, "probe.ts");
      await writeFile(
        probe,
        [
          `import { runInProcess } from ${JSON.stringify(join(tree, "node_modules", packageName, "kernel/src/kernel/index.ts"))};`,
          `import { programsAddon } from ${JSON.stringify(join(tree, "node_modules", packageName, "kernel/src/addons/programs/index.ts"))};`,
          `import { moonsCli } from ${JSON.stringify(join(tree, "src/commands.ts"))};`,
          `const cli = moonsCli(${JSON.stringify(home)}, "/usr/bin/true");`,
          "const realKill = process.kill.bind(process);",
          "const fakeKill: typeof process.kill = (pid, signal) => {",
          "  if (pid < 0 && signal === 0) return true;",
          "  return realKill(pid, signal);",
          "};",
          "const base = programsAddon();",
          "const wrapped = {",
          "  attach(run: Parameters<typeof base.attach>[0]) {",
          "    const attached = base.attach(run);",
          "    return {",
          "      ...attached,",
          "      settle(limit?: number) {",
          "        process.kill = realKill;",
          "        return attached.settle(limit);",
          "      },",
          "    };",
          "  },",
          "};",
          "const run = runInProcess(cli.contract, { emergencyRecord: cli.setup.emergencyRecord, addons: { programs: wrapped } });",
          "process.kill = fakeKill;",
          "try {",
          '  const visit = await run(["visit", "venus"]);',
          '  const pending = await run(["pending"]);',
          "  process.stdout.write(JSON.stringify({ visit, pending }));",
          "} finally {",
          "  process.kill = realKill;",
          "}",
          "",
        ].join("\n"),
      );
      const ran = await spawnBounded([process.execPath, probe], { cwd: tree });
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      const observed: unknown = JSON.parse(ran.stdout);
      expect(observed).toMatchObject({
        visit: {
          kind: "envelope",
          exitCode: 3,
          envelope: {
            result: {
              outcome: "failed",
              causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
              transactionState: "unknown",
              effects: {
                completed: ["planet.record"],
                remaining: [],
                uncertain: ["viewer.launch"],
              },
            },
          },
        },
        pending: {
          kind: "envelope",
          exitCode: 0,
          envelope: {
            result: {
              data: {
                unfinished: [
                  {
                    planet: "venus",
                    effects: ["planet.record", "viewer.launch"],
                  },
                ],
              },
            },
          },
        },
      });
    },
    processWatchdog(1),
  );

  test(
    "the example's visit treats missing programDetails as an unconfirmed launch",
    async () => {
      const tree = await exampleTree();
      const home = ownedFolder("kernel-author-guide-missing-details-");
      const probe = join(home, "probe.ts");
      await writeFile(
        probe,
        [
          `import { runInProcess } from ${JSON.stringify(join(tree, "node_modules", packageName, "kernel/src/kernel/index.ts"))};`,
          `import { moonsCli } from ${JSON.stringify(join(tree, "src/commands.ts"))};`,
          `const cli = moonsCli(${JSON.stringify(home)}, "/usr/bin/true");`,
          "const unrecorded = {",
          "  attach(run: { readonly runId: string }) {",
          "    const plain = () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, terminationConfirmed: true, outputTruncated: false });",
          "    return {",
          "      capability: {",
          "        inspect: plain,",
          "        supplied: plain,",
          "        domain(recorded: { readonly effect: string; readonly admitStart: (runId: string, effect: string, fn: () => Promise<unknown>) => Promise<unknown> }) {",
          "          return {",
          "            effect: recorded.effect,",
          "            start: () => recorded.admitStart(run.runId, recorded.effect, plain),",
          "          };",
          "        },",
          "      },",
          "      settle: () => Promise.resolve(true),",
          "      killNow: () => undefined,",
          "    };",
          "  },",
          "};",
          "const run = runInProcess(cli.contract, { emergencyRecord: cli.setup.emergencyRecord, addons: { programs: unrecorded } });",
          'const visit = await run(["visit", "venus"]);',
          'const pending = await run(["pending"]);',
          "process.stdout.write(JSON.stringify({ visit, pending }));",
          "",
        ].join("\n"),
      );
      const ran = await spawnBounded([process.execPath, probe], { cwd: tree });
      expect({ exit: ran.exit, stderr: ran.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      const observed: unknown = JSON.parse(ran.stdout);
      expect(observed).toMatchObject({
        visit: {
          kind: "envelope",
          exitCode: 3,
          envelope: {
            result: {
              outcome: "failed",
              causeCode: "DOMAIN_MOONS_VISIT_UNCONFIRMED",
              transactionState: "unknown",
              effects: {
                completed: ["planet.record"],
                remaining: [],
                uncertain: ["viewer.launch"],
              },
            },
          },
        },
        pending: {
          kind: "envelope",
          exitCode: 0,
          envelope: {
            result: {
              data: {
                unfinished: [
                  {
                    planet: "venus",
                    effects: ["planet.record", "viewer.launch"],
                  },
                ],
              },
            },
          },
        },
      });
    },
    processWatchdog(1),
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
  test(`references/example.md and references/example-tests.md show each example file whole, as ${writeCommand} writes them`, () => {
    const covered: string[] = [];
    for (const entry of exampleDocuments) {
      const subset = exampleFilesFor(example, entry.prefix);
      const current = readFileSync(entry.path, "utf8");
      expect(current).toBe(exampleDocument(current, subset, entry.document));
      covered.push(...subset.keys());
    }
    expect(covered.sort()).toEqual([...example.keys()].sort());
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
      "references/changing.md",
      "references/commands.md",
      "references/example-tests.md",
      "references/example.md",
      "references/menu.md",
      "references/source-layout.md",
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

  test("stations.md: approval listed without state throws from contractFor, before any command runs, with the message the guide quotes, and a contract with no installedAddons builds", () => {
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
        "The invocation uses --wat, an option this command does not declare.",
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

  test("commands.md: a long option accepts both space and equals forms, a boolean flag refuses a value, and a one-dash alias takes its value as the next word only", async () => {
    const count = kernel.command({
      identity: "guide.count",
      route: ["count"],
      summary: "Count.",
      input: {
        ...emptyInput,
        options: [
          {
            name: "--to",
            aliases: ["-t"],
            summary: "Where to stop.",
            required: false,
            repeatable: false,
            value: { kind: "integer", minimum: 0, maximum: 9 },
          },
          {
            name: "--verbose",
            aliases: [],
            summary: "Verbose.",
            required: false,
            repeatable: false,
            value: null,
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
    expect(await run(["count", "--to=3"])).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: { result: { data: 3 } },
    });
    expect(await run(["count", "--verbose=yes"])).toMatchObject(
      usageRefusal("The option --verbose takes no value."),
    );
    expect(await run(["count", "-t=3"])).toMatchObject(
      usageRefusal(
        "The invocation uses -t, an option this command does not declare. Did you mean --to?",
      ),
    );
  });

  test("menu.md: a menu command requires notInteractiveCause, refuses before handler entry when not interactive, and picks or cancels with scriptedTerminal", async () => {
    const causes = {
      ...kernel.commonCauses,
      DOMAIN_GUIDE_NEEDS_TERMINAL: {
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "domain",
        exitCode: 3,
        retryable: false,
        guidance: "next",
      },
      DOMAIN_GUIDE_NOTHING_CHOSEN: {
        outcome: "refused",
        transactionState: "unchanged",
        failureClass: "domain",
        exitCode: 3,
        retryable: false,
        guidance: "next",
      },
    } as const satisfies kernel.CauseTable;
    const stations = [
      kernel.station(causes, {
        ...stationWords,
        commandIdentity: "guide.choose",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Picked.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: "guide.choose:picked",
      }),
      kernel.station(causes, {
        ...stationWords,
        commandIdentity: "guide.choose",
        causeCode: "DOMAIN_GUIDE_NEEDS_TERMINAL",
        trigger: "Needs an interactive terminal.",
        repairAction: "Run in a terminal.",
        guidance: { next: { kind: "instruction", text: "Run interactively." } },
        independentObservable: "guide.choose:needs-terminal",
      }),
      kernel.station(causes, {
        ...stationWords,
        commandIdentity: "guide.choose",
        causeCode: "DOMAIN_GUIDE_NOTHING_CHOSEN",
        trigger: "Cancelled at the menu.",
        repairAction: "Run again to choose.",
        guidance: { next: { kind: "instruction", text: "Choose an item." } },
        independentObservable: "guide.choose:cancelled",
      }),
    ] as const;
    expect(() =>
      kernel.command({
        identity: "guide.choose",
        route: ["choose"],
        summary: "Choose.",
        input: emptyInput,
        capabilities: { menu: true },
        stations,
        run: (_input, context) =>
          context.result(
            { commandIdentity: "guide.choose", causeCode: "SUCCESS_UNCHANGED" },
            { message: "Done.", data: null, effects: unchanged },
          ),
      }),
    ).toThrow("notInteractiveCause");

    let calls = 0;
    const choose = kernel.command({
      identity: "guide.choose",
      route: ["choose"],
      summary: "Choose.",
      input: emptyInput,
      capabilities: { menu: true },
      notInteractiveCause: "DOMAIN_GUIDE_NEEDS_TERMINAL",
      stations,
      run: async (_input, context) => {
        calls += 1;
        const picked = await context.menu.show({
          lines: ["Choose one:"],
          rows: [{ label: "first", value: "first" }],
        });
        if (picked.kind === "cancelled")
          return context.result(
            {
              commandIdentity: "guide.choose",
              causeCode: "DOMAIN_GUIDE_NOTHING_CHOSEN",
            },
            { message: "Nothing was opened.", data: null, effects: unchanged },
          );
        return context.result(
          { commandIdentity: "guide.choose", causeCode: "SUCCESS_UNCHANGED" },
          { message: picked.value, data: picked.value, effects: unchanged },
        );
      },
    });
    const contract = kernel.contractFor({
      cli: "guide",
      commands: [choose],
      causes,
      installedAddons: ["menu"],
    });
    expect(
      await kernel.runInProcess(contract, { addons: { menu: menuAddon() } })([
        "choose",
      ]),
    ).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: { result: { causeCode: "DOMAIN_GUIDE_NEEDS_TERMINAL" } },
    });
    expect(calls).toBe(0);
    expect(
      await kernel.runInProcess(contract, {
        addons: { menu: menuAddon() },
        terminal: kernel.scriptedTerminal(["\x1b"]),
      })(["choose"]),
    ).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: { result: { causeCode: "DOMAIN_GUIDE_NOTHING_CHOSEN" } },
    });
    expect(
      await kernel.runInProcess(contract, {
        addons: { menu: menuAddon() },
        terminal: kernel.scriptedTerminal(["\r"]),
      })(["choose"]),
    ).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: { result: { data: "first" } },
    });
  });
});

describe("kernel behaviour changing.md states in words", () => {
  const causes = {
    ...kernel.commonCauses,
    DOMAIN_GUIDE_HELD: refusedHandoff,
    DOMAIN_GUIDE_UNRESOLVED: refusedHandoff,
    DOMAIN_GUIDE_NEXT: { ...refusedHandoff, guidance: "next" },
    DOMAIN_GUIDE_NOT_OPENED: {
      ...refusedHandoff,
      outcome: "failed",
      transactionState: "completed",
    },
    DOMAIN_GUIDE_PARTIAL: {
      ...refusedHandoff,
      outcome: "failed",
      transactionState: "partially-completed",
    },
    DOMAIN_GUIDE_UNKNOWN: {
      ...refusedHandoff,
      outcome: "failed",
      transactionState: "unknown",
    },
  } as const;
  const look = {
    owner: "human",
    reason: "Look.",
    inspect: [{ kind: "command", command: "guide.pending", args: [] }],
  } as const;
  type Refusal =
    | "DOMAIN_GUIDE_HELD"
    | "DOMAIN_GUIDE_UNRESOLVED"
    | "DOMAIN_GUIDE_NOT_OPENED"
    | "DOMAIN_GUIDE_PARTIAL"
    | "DOMAIN_GUIDE_UNKNOWN"
    | "DOMAIN_AUTHORITY_REQUIRED";
  const refusalWords = {
    ...stationWords,
    commandIdentity: "guide.change",
    trigger: "The change was refused or not confirmed.",
    repairAction: "Ask a person.",
    guidance: { handoff: look },
  } as const;
  const refusals = [
    kernel.station(causes, {
      ...refusalWords,
      causeCode: "DOMAIN_GUIDE_HELD",
      independentObservable: "guide.change:held",
    }),
    kernel.station(causes, {
      ...refusalWords,
      causeCode: "DOMAIN_GUIDE_UNRESOLVED",
      independentObservable: "guide.change:unresolved",
    }),
    kernel.station(causes, {
      ...refusalWords,
      causeCode: "DOMAIN_GUIDE_NOT_OPENED",
      independentObservable: "guide.change:not-opened",
    }),
    kernel.station(causes, {
      ...refusalWords,
      causeCode: "DOMAIN_GUIDE_PARTIAL",
      independentObservable: "guide.change:partial",
    }),
    kernel.station(causes, {
      ...refusalWords,
      causeCode: "DOMAIN_GUIDE_UNKNOWN",
      independentObservable: "guide.change:unknown",
    }),
    kernel.station(causes, {
      ...refusalWords,
      causeCode: "DOMAIN_AUTHORITY_REQUIRED",
      independentObservable: "guide.change:authority",
    }),
  ] as const;
  const nextRefusal = kernel.station(causes, {
    ...stationWords,
    commandIdentity: "guide.change",
    causeCode: "DOMAIN_GUIDE_NEXT",
    trigger: "Refused with a next step.",
    repairAction: "Run it again.",
    guidance: { next: { kind: "instruction", text: "Run it again." } },
    independentObservable: "guide.change:next",
  });
  const succeeded = kernel.station(causes, {
    ...stationWords,
    commandIdentity: "guide.change",
    causeCode: "SUCCESS_COMPLETED",
    trigger: "The change was made.",
    repairAction: null,
    guidance: { next: { kind: "done" } },
    independentObservable: "guide.change:done",
  });

  function stateIn(report = "guide.pending") {
    const root = join(ownedFolder("kernel-author-guide-state-"), "state");
    return stateAddon({ root, report });
  }

  function change(
    state: ReturnType<typeof stateIn>,
    words: {
      readonly effects?: readonly [string, ...string[]];
      readonly held?: Refusal;
      readonly unresolved?: Refusal | "DOMAIN_GUIDE_NEXT";
      readonly readBack?: boolean | (() => Promise<boolean>);
      readonly ifNoResult?: kernel.IfNoResult;
      readonly deadlineSupported?: boolean;
      readonly beforeTransaction?: (signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    return kernel.changing({
      identity: "guide.change",
      route: ["change"],
      summary: "Change one thing.",
      input: {
        ...emptyInput,
        deadlineSupported: words.deadlineSupported ?? false,
      },
      capabilities: {},
      effectClass: "repository-local",
      effects: words.effects ?? ["guide.write"],
      ifNoResult: words.ifNoResult ?? state.descriptor.ifNoResult,
      heldLockCause: words.held ?? "DOMAIN_GUIDE_HELD",
      unresolvedCaseCause: words.unresolved ?? "DOMAIN_GUIDE_UNRESOLVED",
      stations: [succeeded, nextRefusal, ...refusals],
      run: async (_input, context) => {
        await words.beforeTransaction?.(context.signal);
        const outcome = await state.transaction(
          context.state,
          {
            command: "guide.change",
            scope: { resources: [{ resource: "guide", key: "one" }] },
          },
          async (transaction) => {
            const readBack = words.readBack;
            await transaction.record(
              "guide.write",
              () => Promise.resolve(),
              typeof readBack === "function"
                ? readBack
                : () => Promise.resolve(readBack ?? true),
            );
          },
        );
        if (outcome.kind !== "ran")
          return context.result(
            {
              commandIdentity: "guide.change",
              causeCode: "DOMAIN_GUIDE_UNRESOLVED",
            },
            { message: outcome.kind, data: null, effects: unchanged },
          );
        return outcome.proof.transactionState === "completed"
          ? context.result(
              {
                commandIdentity: "guide.change",
                causeCode: "SUCCESS_COMPLETED",
              },
              { message: "Changed.", data: null, transaction: outcome.proof },
            )
          : context.result(
              {
                commandIdentity: "guide.change",
                causeCode: "DOMAIN_GUIDE_UNKNOWN",
              },
              {
                message: "Unconfirmed.",
                data: null,
                transaction: outcome.proof,
              },
            );
      },
    });
  }

  function pending(
    next:
      | { readonly kind: "done" }
      | { readonly kind: "instruction"; readonly text: string } = {
      kind: "instruction",
      text: "Look.",
    },
    input: kernel.InputSchema = emptyInput,
    readsFrom?: ReturnType<typeof stateIn>,
  ) {
    return kernel.command({
      identity: "guide.pending",
      route: ["pending"],
      summary: "List unfinished changes.",
      input,
      capabilities: {},
      stations: [
        kernel.station(causes, {
          ...stationWords,
          commandIdentity: "guide.pending",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Read.",
          repairAction: null,
          guidance: { next },
          independentObservable: "guide.pending:read",
        }),
      ],
      run: (_input, context) => {
        const report = readsFrom?.report();
        return context.result(
          { commandIdentity: "guide.pending", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Read.",
            data: { unfinished: report?.ok ? report.unfinished : [] },
            effects: unchanged,
          },
        );
      },
    });
  }

  const stateful = (state: ReturnType<typeof stateIn>) =>
    ({
      cli: "guide",
      causes,
      state: state.descriptor,
      installedAddons: ["state"],
    }) as const;

  test("changing.md: a contract with a changing command and its pending command builds", () => {
    const state = stateIn();
    expect(
      kernel.contractFor({
        ...stateful(state),
        commands: [change(state), pending()],
      }).cli,
    ).toBe("guide");
  });

  test("changing.md: empty effects or a repeated effect throws Invalid changing declaration.", () => {
    const state = stateIn();
    expect(() => {
      Reflect.apply(kernel.changing, undefined, [
        {
          identity: "guide.change",
          route: ["change"],
          summary: "Change one thing.",
          input: emptyInput,
          capabilities: {},
          effectClass: "repository-local",
          effects: [],
          ifNoResult: state.descriptor.ifNoResult,
          heldLockCause: "DOMAIN_GUIDE_HELD",
          unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",
          stations: [succeeded, ...refusals],
          run: () => Promise.reject(new Error("never runs")),
        },
      ]);
    }).toThrow(new Error("Invalid changing declaration."));
    expect(() =>
      change(state, { effects: ["guide.write", "guide.write"] }),
    ).toThrow(new Error("Invalid changing declaration."));
  });

  test("changing.md: a changing command without the state add-on throws Changing commands require the state add-on.", () => {
    const state = stateIn();
    expect(() =>
      kernel.contractFor({
        cli: "guide",
        causes,
        commands: [change(state), pending()],
      }),
    ).toThrow(new Error("Changing commands require the state add-on."));
  });

  test("changing.md: an ifNoResult that the state add-on did not make throws when changing() runs", () => {
    const state = stateIn();
    const other = stateIn();
    expect(() =>
      change(state, {
        ifNoResult: structuredClone(other.descriptor.ifNoResult),
      }),
    ).toThrow(
      new Error("ifNoResult must come from the state add-on descriptor."),
    );
  });

  test("changing.md: a report command that commands does not hold throws ifNoResult must name a declared inspect command.", () => {
    const state = stateIn("guide.report");
    expect(() =>
      kernel.contractFor({
        ...stateful(state),
        commands: [change(state), pending()],
      }),
    ).toThrow(new Error("ifNoResult must name a declared inspect command."));
  });

  test("changing.md: a declared report command that is not inspect throws ifNoResult must name a declared inspect command.", () => {
    const state = stateIn("guide.change");
    expect(() =>
      kernel.contractFor({
        ...stateful(state),
        commands: [change(state), pending()],
      }),
    ).toThrow(new Error("ifNoResult must name a declared inspect command."));
  });

  test("changing.md: a pending command whose success guidance is done throws ifNoResult needs explicit further inspection guidance.", () => {
    const state = stateIn();
    expect(() =>
      kernel.contractFor({
        ...stateful(state),
        commands: [change(state), pending({ kind: "done" })],
      }),
    ).toThrow(
      new Error("ifNoResult needs explicit further inspection guidance."),
    );
  });

  test("changing.md: a pending command with a required argument throws, because its ifNoResult step can never parse", () => {
    const state = stateIn();
    expect(() =>
      kernel.contractFor({
        ...stateful(state),
        commands: [
          change(state),
          pending(undefined, {
            ...emptyInput,
            arguments: [
              {
                name: "id",
                summary: "An id.",
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
          }),
        ],
      }),
    ).toThrow(
      new Error(
        "ifNoResult step guide.pending [] can never parse: required id is absent.",
      ),
    );
  });

  test("changing.md: an ifNoResult step carrying a global switch before -- throws at start-up", () => {
    const descriptor = createStateAddon((issuer) => ({
      ifNoResult: issuer.ifNoResult({
        kind: "command",
        command: "guide.pending",
        args: ["--json"],
      }),
      attach: () => ({
        transaction: () => Promise.reject(new Error("never runs")),
      }),
    }));
    const state = stateIn();
    expect(() =>
      kernel.contractFor({
        cli: "guide",
        causes,
        state: descriptor,
        installedAddons: ["state"],
        commands: [
          change(state, { ifNoResult: descriptor.ifNoResult }),
          pending(),
        ],
      }),
    ).toThrow(
      new Error(
        'ifNoResult step guide.pending ["--json"] carries a global switch before --.',
      ),
    );
  });

  test("changing.md: an ifNoResult step that routes to another command throws at start-up", () => {
    const descriptor = createStateAddon((issuer) => ({
      ifNoResult: issuer.ifNoResult({
        kind: "command",
        command: "guide.pending",
        args: ["all"],
      }),
      attach: () => ({
        transaction: () => Promise.reject(new Error("never runs")),
      }),
    }));
    const state = stateIn();
    const pendingWithArg = pending(undefined, {
      ...emptyInput,
      arguments: [
        {
          name: "scope",
          summary: "Optional scope.",
          required: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 9,
            choices: null,
            pattern: null,
          },
        },
      ],
    });
    const pendingAll = kernel.command({
      identity: "guide.pending-all",
      route: ["pending", "all"],
      summary: "List all unfinished changes.",
      input: emptyInput,
      capabilities: {},
      run: (_input, context) =>
        context.result(
          {
            commandIdentity: "guide.pending-all",
            causeCode: "SUCCESS_UNCHANGED",
          },
          { message: "Read.", data: null, effects: unchanged },
        ),
    });
    expect(() =>
      kernel.contractFor({
        cli: "guide",
        causes,
        state: descriptor,
        installedAddons: ["state"],
        commands: [
          change(state, { ifNoResult: descriptor.ifNoResult }),
          pendingWithArg,
          pendingAll,
        ],
      }),
    ).toThrow(
      new Error(
        'ifNoResult step guide.pending ["all"] routes to guide.pending-all.',
      ),
    );
  });

  test("changing.md: one cause for both coordination refusals, or an undeclared coordination cause, throws Changing commands need distinct coordination refusal stations.", () => {
    const state = stateIn();
    expect(() =>
      change(state, {
        held: "DOMAIN_GUIDE_UNRESOLVED",
        unresolved: "DOMAIN_GUIDE_UNRESOLVED",
      }),
    ).toThrow(
      new Error(
        "Changing commands need distinct coordination refusal stations.",
      ),
    );
    expect(() =>
      kernel.changing({
        identity: "guide.change",
        route: ["change"],
        summary: "Change one thing.",
        input: emptyInput,
        capabilities: {},
        effectClass: "repository-local",
        effects: ["guide.write"],
        ifNoResult: state.descriptor.ifNoResult,
        heldLockCause: "DOMAIN_GUIDE_UNDECLARED",
        unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",
        stations: [succeeded, ...refusals],
        run: () => Promise.reject(new Error("never runs")),
      }),
    ).toThrow(
      new Error(
        "Changing commands need distinct coordination refusal stations.",
      ),
    );
  });

  test("changing.md: a kernel cause as a coordination refusal throws Coordination refusal causes are host-owned.", () => {
    const state = stateIn();
    expect(() =>
      kernel.contractFor({
        ...stateful(state),
        commands: [
          change(state, { held: "DOMAIN_AUTHORITY_REQUIRED" }),
          pending(),
        ],
      }),
    ).toThrow(new Error("Coordination refusal causes are host-owned."));
  });

  test("changing.md: a coordination refusal with a next step throws Coordination refusal requires an unchanged handoff.", () => {
    const state = stateIn();
    expect(() =>
      kernel.contractFor({
        ...stateful(state),
        commands: [
          change(state, { unresolved: "DOMAIN_GUIDE_NEXT" }),
          pending(),
        ],
      }),
    ).toThrow(new Error("Coordination refusal requires an unchanged handoff."));
  });

  test("changing.md: a read-back that returns false or throws leaves a case pending lists, and the next change to that scope is refused as unresolved", async () => {
    for (const readBack of [
      false,
      () => Promise.reject(new Error("read failed")),
    ] as const) {
      const state = stateIn();
      const failing = kernel.runInProcess(
        kernel.contractFor({
          ...stateful(state),
          commands: [
            change(state, { readBack }),
            pending(undefined, undefined, state),
          ],
        }),
        { emergencyRecord: state.emergencyRecord },
      );
      expect(await failing(["change"])).toMatchObject({
        kind: "envelope",
        exitCode: 3,
        envelope: {
          result: {
            causeCode: "DOMAIN_GUIDE_UNKNOWN",
            transactionState: "unknown",
            effects: { uncertain: ["guide.write"] },
          },
        },
      });
      expect(await failing(["pending"])).toMatchObject({
        kind: "envelope",
        envelope: {
          result: { data: { unfinished: [{ effects: ["guide.write"] }] } },
        },
      });
      expect(await failing(["change"])).toMatchObject({
        kind: "envelope",
        envelope: {
          message: "unresolved-case",
          result: {
            exitCode: 3,
            causeCode: "DOMAIN_GUIDE_UNRESOLVED",
            transactionState: "unchanged",
            effects: unchanged,
          },
        },
      });
    }
  });

  test("changing.md: a partially-completed proof requires a cause whose declared transaction state is partially-completed", async () => {
    const runPartial = (
      selectedCause: "DOMAIN_GUIDE_UNKNOWN" | "DOMAIN_GUIDE_PARTIAL",
    ) => {
      const state = stateIn();
      const partialCommand = kernel.changing({
        identity: "guide.change",
        route: ["change"],
        summary: "Change two things.",
        input: emptyInput,
        capabilities: {},
        effectClass: "repository-local",
        effects: ["guide.first", "guide.second"],
        ifNoResult: state.descriptor.ifNoResult,
        heldLockCause: "DOMAIN_GUIDE_HELD",
        unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",
        stations: [succeeded, ...refusals],
        run: async (_input, context) => {
          const outcome = await state.transaction(
            context.state,
            {
              command: "guide.change",
              scope: { resources: [{ resource: "guide", key: "one" }] },
            },
            async (transaction) => {
              await transaction.record(
                "guide.first",
                () => Promise.resolve(),
                () => Promise.resolve(true),
              );
            },
          );
          if (outcome.kind !== "ran")
            return context.result(
              {
                commandIdentity: "guide.change",
                causeCode: "DOMAIN_GUIDE_UNRESOLVED",
              },
              { message: outcome.kind, data: null, effects: unchanged },
            );
          return context.result(
            { commandIdentity: "guide.change", causeCode: selectedCause },
            {
              message: "Partial.",
              data: null,
              transaction: outcome.proof,
            },
          );
        },
      });
      return kernel.runInProcess(
        kernel.contractFor({
          ...stateful(state),
          commands: [partialCommand, pending(undefined, undefined, state)],
        }),
        { emergencyRecord: state.emergencyRecord },
      )(["change"]);
    };
    expect(await runPartial("DOMAIN_GUIDE_UNKNOWN")).toMatchObject({
      kind: "envelope",
      exitCode: 1,
      envelope: {
        result: {
          causeCode: "INTERNAL_RESULT_PARTIAL",
          transactionState: "partially-completed",
          effects: { completed: ["guide.first"], remaining: ["guide.second"] },
        },
      },
    });
    expect(await runPartial("DOMAIN_GUIDE_PARTIAL")).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: {
        result: {
          outcome: "failed",
          causeCode: "DOMAIN_GUIDE_PARTIAL",
          transactionState: "partially-completed",
          effects: { completed: ["guide.first"], remaining: ["guide.second"] },
        },
      },
    });
  });

  test(
    "changing.md: a launch read back from terminationConfirmed ends failed and completed on a non-zero exit and leaves nothing pending, so the next change runs",
    async () => {
      const state = stateIn();
      const runWith = (opener: string) => {
        const launch = kernel.changing({
          identity: "guide.change",
          route: ["change"],
          summary: "Launch one program.",
          input: emptyInput,
          capabilities: { programs: true },
          effectClass: "external",
          effects: ["viewer.launch"],
          ifNoResult: state.descriptor.ifNoResult,
          heldLockCause: "DOMAIN_GUIDE_HELD",
          unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",
          stations: [succeeded, ...refusals],
          run: async (_input, context) => {
            let exitCode: number | null = null;
            const outcome = await state.transaction(
              context.state,
              {
                command: "guide.change",
                scope: { resources: [{ resource: "guide", key: "one" }] },
              },
              async (transaction) => {
                const launched = await transaction.record(
                  "viewer.launch",
                  (recorded) =>
                    context.programs.domain(recorded).start({
                      executable: viewer,
                      args: [],
                      timeoutMilliseconds: 10_000,
                      outputLimitBytes: 4_096,
                      shutdownMilliseconds: 1_000,
                    }),
                  (result) => {
                    const details = programDetails(result);
                    return Promise.resolve(
                      !context.signal.aborted &&
                        result.exitCode !== null &&
                        result.terminationConfirmed &&
                        details !== undefined &&
                        !details.timedOut,
                    );
                  },
                );
                exitCode = launched.exitCode;
              },
            );
            if (outcome.kind !== "ran")
              return context.result(
                {
                  commandIdentity: "guide.change",
                  causeCode: "DOMAIN_GUIDE_UNRESOLVED",
                },
                { message: outcome.kind, data: null, effects: unchanged },
              );
            if (outcome.proof.transactionState !== "completed")
              return context.result(
                {
                  commandIdentity: "guide.change",
                  causeCode: "DOMAIN_GUIDE_UNKNOWN",
                },
                {
                  message: "Unconfirmed.",
                  data: null,
                  transaction: outcome.proof,
                },
              );
            return exitCode === 0
              ? context.result(
                  {
                    commandIdentity: "guide.change",
                    causeCode: "SUCCESS_COMPLETED",
                  },
                  {
                    message: "Launched.",
                    data: null,
                    transaction: outcome.proof,
                  },
                )
              : context.result(
                  {
                    commandIdentity: "guide.change",
                    causeCode: "DOMAIN_GUIDE_NOT_OPENED",
                  },
                  {
                    message: `Opener exited ${String(exitCode)}.`,
                    data: null,
                    transaction: outcome.proof,
                  },
                );
          },
        });
        const contract = kernel.contractFor({
          cli: "guide",
          causes,
          state: state.descriptor,
          installedAddons: ["state", "programs"],
          commands: [launch, pending(undefined, undefined, state)],
        });
        const viewer = contract.boundary.path(opener);
        return kernel.runInProcess(contract, {
          addons: { programs: programsAddon() },
          emergencyRecord: state.emergencyRecord,
        });
      };
      const failing = runWith("/usr/bin/false");
      expect(await failing(["change"])).toMatchObject({
        kind: "envelope",
        exitCode: 3,
        envelope: {
          result: {
            outcome: "failed",
            causeCode: "DOMAIN_GUIDE_NOT_OPENED",
            transactionState: "completed",
            effects: { completed: ["viewer.launch"] },
            handoff: { owner: "human" },
          },
        },
      });
      expect(await failing(["pending"])).toMatchObject({
        kind: "envelope",
        envelope: { result: { data: { unfinished: [] } } },
      });
      expect(await runWith("/usr/bin/true")(["change"])).toMatchObject({
        kind: "envelope",
        exitCode: 0,
        envelope: {
          result: {
            causeCode: "SUCCESS_COMPLETED",
            transactionState: "completed",
          },
        },
      });
    },
    processWatchdog(2),
  );

  test("changing.md: a deadline before the transaction opens closes the state capability, answers DOMAIN_DEADLINE_UNCHANGED, and leaves nothing pending", async () => {
    const state = stateIn();
    let transactionError = "";
    const deadlineCommand = kernel.changing({
      identity: "guide.change",
      route: ["change"],
      summary: "Change one thing.",
      input: { ...emptyInput, deadlineSupported: true },
      capabilities: {},
      effectClass: "repository-local",
      effects: ["guide.write"],
      ifNoResult: state.descriptor.ifNoResult,
      heldLockCause: "DOMAIN_GUIDE_HELD",
      unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",
      stations: [succeeded, ...refusals],
      run: async (_input, context) => {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            resolve();
            return;
          }
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        try {
          await state.transaction(
            context.state,
            {
              command: "guide.change",
              scope: { resources: [{ resource: "guide", key: "one" }] },
            },
            async (transaction) => {
              await transaction.record(
                "guide.write",
                () => Promise.resolve(),
                () => Promise.resolve(true),
              );
            },
          );
        } catch (error) {
          transactionError =
            error instanceof Error ? error.message : String(error);
        }
        return context.result(
          {
            commandIdentity: "guide.change",
            causeCode: "DOMAIN_GUIDE_UNRESOLVED",
          },
          { message: "Stopped.", data: null, effects: unchanged },
        );
      },
    });
    const run = kernel.runInProcess(
      kernel.contractFor({
        ...stateful(state),
        commands: [deadlineCommand, pending(undefined, undefined, state)],
      }),
      { emergencyRecord: state.emergencyRecord },
    );
    const expired = await run(["change", "--deadline-ms", "25"]);
    expect(expired).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: {
        result: {
          outcome: "failed",
          causeCode: "DOMAIN_DEADLINE_UNCHANGED",
          transactionState: "unchanged",
        },
      },
    });
    expect(transactionError).toBe(
      "The state capability closed at the deadline.",
    );
    expect(await run(["pending"])).toMatchObject({
      kind: "envelope",
      envelope: { result: { data: { unfinished: [] } } },
    });
  });

  test("changing.md: a deadline before handler entry answers DOMAIN_DEADLINE_BEFORE_START and leaves nothing pending", async () => {
    const state = stateIn();
    let entered = 0;
    const deadlineCommand = kernel.changing({
      identity: "guide.change",
      route: ["change"],
      summary: "Change one thing.",
      input: { ...emptyInput, deadlineSupported: true },
      capabilities: {},
      effectClass: "repository-local",
      effects: ["guide.write"],
      ifNoResult: state.descriptor.ifNoResult,
      heldLockCause: "DOMAIN_GUIDE_HELD",
      unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",
      stations: [succeeded, ...refusals],
      run: (_input, context) => {
        entered += 1;
        return Promise.resolve(
          context.result(
            {
              commandIdentity: "guide.change",
              causeCode: "DOMAIN_GUIDE_UNRESOLVED",
            },
            { message: "Entered.", data: null, effects: unchanged },
          ),
        );
      },
    });
    const contract = kernel.contractFor({
      ...stateful(state),
      commands: [deadlineCommand, pending(undefined, undefined, state)],
    });
    let ticks = 0;
    const recorder = recordingHost();
    const expired = await runInProcessOn(
      contract,
      { emergencyRecord: state.emergencyRecord },
      () => ({
        ...recorder.host,
        now: () => (ticks++ === 0 ? 0 : 1_000),
      }),
    )(["change", "--deadline-ms", "10"]);
    expect(entered).toBe(0);
    expect(expired).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: {
        result: {
          outcome: "refused",
          causeCode: "DOMAIN_DEADLINE_BEFORE_START",
          transactionState: "unchanged",
        },
      },
    });
    expect(
      await kernel.runInProcess(contract, {
        emergencyRecord: state.emergencyRecord,
      })(["pending"]),
    ).toMatchObject({
      kind: "envelope",
      envelope: { result: { data: { unfinished: [] } } },
    });
  });

  test("changing.md: on macOS, state.capabilities reports stoppedOwnerProof unavailable and state.close returns stopped-owner-proof-unqualified", async () => {
    const state = stateIn();
    const contract = kernel.contractFor({
      ...stateful(state),
      commands: [
        change(state, { readBack: false }),
        pending(undefined, undefined, state),
      ],
    });
    const run = kernel.runInProcess(contract, {
      emergencyRecord: state.emergencyRecord,
    });
    expect(await run(["change"])).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: { result: { causeCode: "DOMAIN_GUIDE_UNKNOWN" } },
    });
    const listed = state.report();
    expect(listed.ok).toBe(true);
    const operationId = listed.ok
      ? (listed.unfinished[0]?.operationId ?? "")
      : "";
    const history = await state.history(operationId);
    expect(history.ok).toBe(true);
    const revision = history.ok ? history.history.journal.revision : "";
    const capabilities = state.capabilities();
    let closeResult: unknown;
    const closer = kernel.changing({
      identity: "guide.close",
      route: ["close"],
      summary: "Close a case.",
      input: emptyInput,
      capabilities: {},
      effectClass: "repository-local",
      effects: ["guide.close"],
      ifNoResult: state.descriptor.ifNoResult,
      heldLockCause: "DOMAIN_GUIDE_HELD",
      unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",
      stations: [
        kernel.station(causes, {
          ...stationWords,
          commandIdentity: "guide.close",
          causeCode: "SUCCESS_COMPLETED",
          trigger: "Closed.",
          repairAction: null,
          guidance: { next: { kind: "done" } },
          independentObservable: "guide.close:done",
        }),
        kernel.station(causes, {
          ...refusalWords,
          commandIdentity: "guide.close",
          causeCode: "DOMAIN_GUIDE_HELD",
          independentObservable: "guide.close:held",
        }),
        kernel.station(causes, {
          ...refusalWords,
          commandIdentity: "guide.close",
          causeCode: "DOMAIN_GUIDE_UNRESOLVED",
          independentObservable: "guide.close:unresolved",
        }),
      ],
      run: async (_input, context) => {
        closeResult = await state.close(context.state, {
          command: "guide.close",
          effect: "guide.close",
          operationId,
          closureId: "close-1",
          disposition: "completed",
          revision,
          reason: "Check close availability.",
        });
        return context.result(
          {
            commandIdentity: "guide.close",
            causeCode: "DOMAIN_GUIDE_UNRESOLVED",
          },
          { message: "Checked.", data: null, effects: unchanged },
        );
      },
    });
    const runClose = kernel.runInProcess(
      kernel.contractFor({
        ...stateful(state),
        commands: [closer, pending(undefined, undefined, state)],
      }),
      { emergencyRecord: state.emergencyRecord },
    );
    await runClose(["close"]);
    if (process.platform === "darwin") {
      expect(capabilities.stoppedOwnerProof).toBe("unavailable");
      expect(closeResult).toMatchObject({
        kind: "unavailable",
        reason: "stopped-owner-proof-unqualified",
      });
    } else {
      expect(["available", "unavailable", "fixture-only"]).toContain(
        capabilities.stoppedOwnerProof,
      );
    }
  });

  const stopScript = (root: string) =>
    [
      `import * as kernel from ${JSON.stringify(join(repository, "kernel/src/kernel/index.ts"))};`,
      `import { stateAddon } from ${JSON.stringify(join(repository, "kernel/src/addons/state/index.ts"))};`,
      `const state = stateAddon({ root: ${JSON.stringify(root)}, report: "guide.pending" });`,
      'const look = { owner: "human", reason: "Look.", inspect: [{ kind: "command", command: "guide.pending", args: [] }] };',
      'const row = { outcome: "refused", transactionState: "unchanged", failureClass: "domain", exitCode: 3, retryable: false, guidance: "handoff" };',
      "const causes = { ...kernel.commonCauses, DOMAIN_GUIDE_HELD: row, DOMAIN_GUIDE_UNRESOLVED: row };",
      'const words = { retryDelayPolicy: { kind: "none" }, reachability: "required", unreachableRationale: null };',
      "const input = { arguments: [], options: [], constraints: [], deadlineSupported: false, additionalArguments: false, additionalOptions: false };",
      'const station = (causeCode, guidance) => kernel.station(causes, { ...words, commandIdentity: "guide.change", causeCode, trigger: causeCode, repairAction: guidance.next ? null : "Ask.", guidance, independentObservable: causeCode });',
      'const change = kernel.changing({ identity: "guide.change", route: ["change"], summary: "Change.", input, capabilities: {}, effectClass: "repository-local", effects: ["guide.write"], ifNoResult: state.descriptor.ifNoResult, heldLockCause: "DOMAIN_GUIDE_HELD", unresolvedCaseCause: "DOMAIN_GUIDE_UNRESOLVED",',
      '  stations: [station("SUCCESS_COMPLETED", { next: { kind: "done" } }), station("DOMAIN_GUIDE_HELD", { handoff: look }), station("DOMAIN_GUIDE_UNRESOLVED", { handoff: look })],',
      "  run: async (_input, context) => {",
      '    if (process.env.GUIDE_READY) { await Bun.write(process.env.GUIDE_READY, "ready\\n"); await new Promise(() => setInterval(() => undefined, 1000)); }',
      '    const outcome = await state.transaction(context.state, { command: "guide.change", scope: { resources: [{ resource: "guide", key: "one" }] } }, (t) => t.record("guide.write", () => Promise.resolve(), () => Promise.resolve(true)).then(() => undefined));',
      '    return context.result({ commandIdentity: "guide.change", causeCode: "SUCCESS_COMPLETED" }, { message: "Changed.", data: null, transaction: outcome.proof });',
      "  } });",
      'const pending = kernel.command({ identity: "guide.pending", route: ["pending"], summary: "Pending.", input, capabilities: {}, stations: [kernel.station(causes, { ...words, commandIdentity: "guide.pending", causeCode: "SUCCESS_UNCHANGED", trigger: "Read.", repairAction: null, guidance: { next: { kind: "instruction", text: "Look." } }, independentObservable: "read" })], run: (_input, context) => context.result({ commandIdentity: "guide.pending", causeCode: "SUCCESS_UNCHANGED" }, { message: "Read.", data: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } }) });',
      'await kernel.runProcess(kernel.contractFor({ cli: "guide", commands: [change, pending], causes, state: state.descriptor, installedAddons: ["state"] }), { emergencyRecord: state.emergencyRecord })(process.argv.slice(2));',
      "",
    ].join("\n");

  test(
    "changing.md: a stop before the transaction leaves nothing pending, and exits 143 for SIGTERM or 130 for Ctrl-C with nothing printed",
    async () => {
      const folder = ownedFolder("kernel-author-guide-stop-");
      const root = join(folder, "state");
      const script = join(folder, "guide.ts");
      write(folder, "guide.ts", stopScript(root));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== "GUIDE_READY"),
      );
      const first = await spawnBounded(
        [process.execPath, script, "change", "--json"],
        { cwd: folder, env },
      );
      expect(first.exit).toBe(0);
      const stopped = [];
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        const ready = join(folder, `${signal}.ready`);
        const run = await spawnBounded(
          [process.execPath, script, "change", "--json"],
          {
            cwd: folder,
            env: { ...env, GUIDE_READY: ready },
            signalAt: { ledger: ready, line: "ready", signal },
          },
        );
        stopped.push({
          signal,
          ready: existsSync(ready),
          exit: run.exit,
          stdout: run.stdout,
          stderr: run.stderr,
        });
      }
      expect(stopped).toEqual([
        { signal: "SIGTERM", ready: true, exit: 143, stdout: "", stderr: "" },
        { signal: "SIGINT", ready: true, exit: 130, stdout: "", stderr: "" },
      ]);
      const report = stateAddon({ root, report: "guide.pending" }).report();
      expect(report).toEqual({ ok: true, unfinished: [] });
    },
    processWatchdog(3),
  );

  test(
    "changing.md: a stop inside the transaction during launch exits 143 with nothing printed, stops the launched program, leaves a case pending lists, and refuses the next change to that scope",
    async () => {
      const tree = await exampleTree();
      const home = ownedFolder("kernel-author-guide-mid-launch-stop-");
      const ledger = join(home, "ledger");
      const opener = join(home, "wait-opener.sh");
      await writeFile(
        opener,
        [
          "#!/bin/sh",
          'printf "pid %s\\nready\\n" "$$" > "$MOONS_LEDGER"',
          "sleep 60 &",
          "pid=$!",
          'wait "$pid"',
          "",
        ].join("\n"),
      );
      await chmod(opener, 0o755);
      let openerPid: number | undefined;
      try {
        const stopped = await spawnBounded(
          [process.execPath, "src/cli.ts", "visit", "venus", "--json"],
          {
            cwd: tree,
            env: {
              ...process.env,
              MOONS_HOME: home,
              MOONS_OPENER: opener,
              MOONS_LEDGER: ledger,
            },
            signalAt: { ledger, line: "ready", signal: "SIGTERM" },
          },
        );
        expect({
          exit: stopped.exit,
          stdout: stopped.stdout,
          stderr: stopped.stderr,
        }).toEqual({ exit: 143, stdout: "", stderr: "" });
        const pidLine = readFileSync(ledger, "utf8")
          .split("\n")
          .find((line) => line.startsWith("pid "));
        openerPid = pidLine ? Number(pidLine.slice(4)) : undefined;
        expect(Number.isSafeInteger(openerPid) && (openerPid ?? 0) > 0).toBe(
          true,
        );
        expect(await goneWithin(openerPid ?? -1, 2_000)).toBe(true);
        const checkEnv = {
          ...process.env,
          MOONS_HOME: home,
          MOONS_OPENER: "/usr/bin/true",
        };
        const listed = await spawnBounded(
          [process.execPath, "src/cli.ts", "pending", "--json"],
          { cwd: tree, env: checkEnv },
        );
        expect(listed.exit).toBe(0);
        expect(
          Reflect.get(Object(JSON.parse(listed.stdout)), "result"),
        ).toMatchObject({
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            unfinished: [
              { planet: "venus", effects: ["planet.record", "viewer.launch"] },
            ],
          },
        });
        const blocked = await spawnBounded(
          [process.execPath, "src/cli.ts", "visit", "venus", "--json"],
          { cwd: tree, env: checkEnv },
        );
        expect(blocked.exit).toBe(3);
        expect(
          Reflect.get(Object(JSON.parse(blocked.stdout)), "result"),
        ).toMatchObject({
          outcome: "refused",
          causeCode: "DOMAIN_MOONS_VISIT_UNRESOLVED",
          transactionState: "unchanged",
        });
      } finally {
        if (openerPid !== undefined && openerPid > 0)
          signalGroupIfPresent(openerPid, "SIGKILL");
      }
    },
    processWatchdog(3),
  );

  test("changing.md: supersedeUnresolved closes an earlier unresolved case of the same command on the next run with outcome-unknown", async () => {
    const root = join(ownedFolder("kernel-author-guide-supersede-"), "state");
    const state = stateAddon({ root, report: "ag.pending" });
    const causes = {
      ...kernel.commonCauses,
      DOMAIN_AG_HELD: refusedHandoff,
      DOMAIN_AG_UNRESOLVED: refusedHandoff,
      DOMAIN_AG_UNKNOWN: {
        ...refusedHandoff,
        outcome: "failed",
        transactionState: "unknown",
      },
    } as const;
    const pendingStep = {
      kind: "command",
      command: "ag.pending",
      args: [],
    } as const;
    const handoff = {
      handoff: {
        owner: "human",
        reason: "Check pending.",
        inspect: [pendingStep],
      },
    } as const;
    let confirm = false;
    const pending = kernel.command({
      identity: "ag.pending",
      route: ["pending"],
      summary: "List unfinished runs.",
      input: emptyInput,
      capabilities: {},
      stations: [
        kernel.station(causes, {
          ...stationWords,
          commandIdentity: "ag.pending",
          causeCode: "SUCCESS_UNCHANGED",
          trigger: "Read.",
          repairAction: null,
          guidance: {
            next: { kind: "instruction", text: "Inspect unfinished cases." },
          },
          independentObservable: "ag.pending:read",
        }),
      ],
      run: (_input, context) =>
        context.result(
          { commandIdentity: "ag.pending", causeCode: "SUCCESS_UNCHANGED" },
          { message: "Read.", data: null, effects: unchanged },
        ),
    });
    const open = kernel.changing({
      identity: "ag.open",
      route: ["open"],
      summary: "Open a planet page.",
      input: emptyInput,
      capabilities: {},
      effectClass: "repository-local",
      effects: ["page.open"],
      ifNoResult: state.descriptor.ifNoResult,
      heldLockCause: "DOMAIN_AG_HELD",
      unresolvedCaseCause: "DOMAIN_AG_UNRESOLVED",
      stations: [
        kernel.station(causes, {
          ...stationWords,
          commandIdentity: "ag.open",
          causeCode: "SUCCESS_COMPLETED",
          trigger: "Opened.",
          repairAction: null,
          guidance: { next: { kind: "done" } },
          independentObservable: "ag.open:done",
        }),
        kernel.station(causes, {
          ...stationWords,
          commandIdentity: "ag.open",
          causeCode: "DOMAIN_AG_HELD",
          trigger: "Held.",
          repairAction: "Wait.",
          guidance: handoff,
          independentObservable: "ag.open:held",
        }),
        kernel.station(causes, {
          ...stationWords,
          commandIdentity: "ag.open",
          causeCode: "DOMAIN_AG_UNRESOLVED",
          trigger: "Unresolved.",
          repairAction: "Inspect pending.",
          guidance: handoff,
          independentObservable: "ag.open:unresolved",
        }),
        kernel.station(causes, {
          ...stationWords,
          commandIdentity: "ag.open",
          causeCode: "DOMAIN_AG_UNKNOWN",
          trigger: "Unknown.",
          repairAction: "Inspect pending.",
          guidance: handoff,
          independentObservable: "ag.open:unknown",
        }),
      ],
      run: async (_input, context) => {
        const outcome = await state.transaction(
          context.state,
          {
            command: "ag.open",
            scope: { resources: [{ resource: "planet", key: "earth" }] },
            supersedeUnresolved: true,
          },
          async (transaction) => {
            await transaction.record(
              "page.open",
              () => Promise.resolve(),
              () => Promise.resolve(confirm),
            );
          },
        );
        if (outcome.kind !== "ran")
          return context.result(
            { commandIdentity: "ag.open", causeCode: "DOMAIN_AG_UNRESOLVED" },
            { message: outcome.kind, data: null, effects: unchanged },
          );
        if (outcome.proof.transactionState === "completed")
          return context.result(
            { commandIdentity: "ag.open", causeCode: "SUCCESS_COMPLETED" },
            {
              message: outcome.proof.transactionState,
              data: { operationId: outcome.operationId },
              transaction: outcome.proof,
            },
          );
        return context.result(
          { commandIdentity: "ag.open", causeCode: "DOMAIN_AG_UNKNOWN" },
          {
            message: outcome.proof.transactionState,
            data: null,
            transaction: outcome.proof,
          },
        );
      },
    });
    const contract = kernel.contractFor({
      cli: "ag",
      commands: [pending, open],
      causes,
      state: state.descriptor,
      installedAddons: ["state"],
    });
    const run = kernel.runInProcess(contract, {
      emergencyRecord: state.emergencyRecord,
    });
    const first = await run(["open"]);
    expect(first).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: { result: { causeCode: "DOMAIN_AG_UNKNOWN" } },
    });
    const listed = state.report();
    expect(listed.ok).toBe(true);
    const oldId = listed.ok ? listed.unfinished[0]?.operationId : undefined;
    expect(oldId).toBeDefined();
    confirm = true;
    const second = await run(["open"]);
    expect(second).toMatchObject({
      kind: "envelope",
      exitCode: 0,
      envelope: {
        result: {
          causeCode: "SUCCESS_COMPLETED",
          ...(oldId === undefined ? {} : { superseded: [oldId] }),
        },
      },
    });
    expect(state.report()).toEqual({ ok: true, unfinished: [] });
    if (oldId !== undefined)
      expect(await state.history(oldId)).toMatchObject({
        ok: true,
        history: {
          status: "closed",
          closure: {
            disposition: "outcome-unknown",
            qualification: supersededQualification,
          },
        },
      });
  });
});
