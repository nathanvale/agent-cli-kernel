import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { documentationEntries } from "../src/cli-inventory.ts";
import { grown, type Tree } from "./support/cli-inventory-fixture.ts";
import { testFolder } from "./support/test-folder.ts";

async function entriesFor(
  tree: Tree,
  document: string,
  toolingNames: string[] = [],
): Promise<string[]> {
  const root = testFolder("cli-inventory-docs-");
  try {
    const files = grown(root, tree);
    const tooling = new Set(toolingNames.map((name) => join(root, name)));
    return await documentationEntries(
      root,
      join(root, document),
      files,
      tooling,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("documentation names an application file that a command runs", async () => {
  expect(
    await entriesFor(
      {
        "README.md": "Start it with `bun run src/main.ts`.\n",
        "src/main.ts": "export {};\n",
      },
      "README.md",
    ),
  ).toEqual(["src/main.ts"]);
});

test.each([
  ["bun", "bun src/main.ts"],
  ["node", "node src/main.ts"],
  ["tsx", "tsx src/main.ts"],
  ["bun run", "bun run src/main.ts"],
  ["a flag between", "bun run --silent --env-file=x src/main.ts"],
  ["double quotes", 'bun run "src/main.ts"'],
  ["single quotes", "bun run 'src/main.ts'"],
])(
  "documentation command form %s names the file it runs",
  async (_form, command) => {
    expect(
      await entriesFor(
        { "README.md": `${command}\n`, "src/main.ts": "export {};\n" },
        "README.md",
      ),
    ).toEqual(["src/main.ts"]);
  },
);

test.each([
  ["after the runtime", "bun  src/main.ts"],
  ["after run", "bun run  src/main.ts"],
  ["after a flag", "bun run --silent  src/main.ts"],
  ["as a tab", "bun\trun\t--silent\tsrc/main.ts"],
])(
  "documentation command with extra space %s names the file it runs",
  async (_where, command) => {
    expect(
      await entriesFor(
        { "README.md": `${command}\n`, "src/main.ts": "export {};\n" },
        "README.md",
      ),
    ).toEqual(["src/main.ts"]);
  },
);

test.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"])(
  "documentation names a %s application file",
  async (extension) => {
    const name = `src/main${extension}`;
    expect(
      await entriesFor(
        { "README.md": `bun run ${name}\n`, [name]: "export {};\n" },
        "README.md",
      ),
    ).toEqual([name]);
  },
);

test("documentation lists each runnable file it names, in order of mention", async () => {
  expect(
    await entriesFor(
      {
        "README.md": "bun run src/b.ts then node src/a.mjs\n",
        "src/a.mjs": "export {};\n",
        "src/b.ts": "export {};\n",
      },
      "README.md",
    ),
  ).toEqual(["src/b.ts", "src/a.mjs"]);
});

test("documentation ignores a runnable file that is not in the inventory", async () => {
  expect(
    await entriesFor({ "README.md": "bun run src/missing.ts\n" }, "README.md"),
  ).toEqual([]);
});

test("documentation ignores a file that a tooling script already runs", async () => {
  expect(
    await entriesFor(
      {
        "README.md": "bun run scripts/check.ts and bun run src/main.ts\n",
        "scripts/check.ts": "export {};\n",
        "src/main.ts": "export {};\n",
      },
      "README.md",
      ["scripts/check.ts"],
    ),
  ).toEqual(["src/main.ts"]);
});

test("documentation ignores a command that does not run a script file", async () => {
  expect(
    await entriesFor(
      {
        "README.md":
          "bun run build and python src/main.py and bun install src/main.txt\n",
        "src/main.py": "",
        "src/main.txt": "",
      },
      "README.md",
    ),
  ).toEqual([]);
});

test("documentation ignores a file name that no command runs", async () => {
  expect(
    await entriesFor(
      {
        "README.md": "See src/main.ts for the code.\n",
        "src/main.ts": "export {};\n",
      },
      "README.md",
    ),
  ).toEqual([]);
});

test("documentation with no command names nothing", async () => {
  expect(await entriesFor({ "README.md": "" }, "README.md")).toEqual([]);
});

test("a path in documentation resolves from the nearest package folder", async () => {
  expect(
    await entriesFor(
      {
        "package.json": "{}",
        "packages/app/package.json": "{}",
        "packages/app/docs/guide.md": "bun run src/main.ts\n",
        "packages/app/src/main.ts": "export {};\n",
        "src/main.ts": "export {};\n",
      },
      "packages/app/docs/guide.md",
    ),
  ).toEqual(["packages/app/src/main.ts"]);
});

test("a path in documentation resolves from the root when no package folder holds it", async () => {
  expect(
    await entriesFor(
      {
        "docs/guide.md": "bun run src/main.ts\n",
        "src/main.ts": "export {};\n",
      },
      "docs/guide.md",
    ),
  ).toEqual(["src/main.ts"]);
});

test("documentation in a package folder is read from that folder", async () => {
  expect(
    await entriesFor(
      {
        "package.json": "{}",
        "README.md": "bun run main.ts\n",
        "main.ts": "export {};\n",
      },
      "README.md",
    ),
  ).toEqual(["main.ts"]);
});
