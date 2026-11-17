import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { documentationEntries, importedSources } from "../src/cli-inventory.ts";
import { testFolder } from "./support/test-folder.ts";

type Tree = Record<string, string>;

function grown(root: string, tree: Tree): Set<string> {
  const paths = new Set<string>();
  for (const [name, text] of Object.entries(tree)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    paths.add(path);
  }
  return paths;
}

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

async function importedBy(tree: Tree): Promise<string[]> {
  const root = testFolder("cli-inventory-imports-");
  try {
    const files = grown(root, tree);
    const imported = await importedSources([...files]);
    return [...imported].map((path) => path.slice(root.length + 1)).sort();
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

test("a file that another source imports is listed as imported", async () => {
  expect(
    await importedBy({
      "src/main.ts": 'import { helper } from "./helper.ts";\nhelper();\n',
      "src/helper.ts": "export function helper() {}\n",
      "src/lonely.ts": "export {};\n",
    }),
  ).toEqual(["src/helper.ts"]);
});

test("an import without a file extension finds the source file", async () => {
  expect(
    await importedBy({
      "src/main.ts": 'import "./helper";\n',
      "src/helper.ts": "export {};\n",
    }),
  ).toEqual(["src/helper.ts"]);
});

test.each([
  [".tsx", "./view"],
  [".mjs", "./view"],
  [".js", "./view"],
  [".mts", "./view"],
  [".cts", "./view"],
  [".cjs", "./view"],
])(
  "an import without an extension finds a %s file",
  async (extension, specifier) => {
    const name = `src/view${extension}`;
    expect(
      await importedBy({
        "src/main.ts": `import "${specifier}";\n`,
        [name]: "export {};\n",
      }),
    ).toEqual([name]);
  },
);

test.each([
  [".js", ".ts"],
  [".js", ".tsx"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
])(
  "an import ending %s finds the emitted source %s",
  async (written, source) => {
    expect(
      await importedBy({
        "src/main.ts": `import "./view${written}";\n`,
        [`src/view${source}`]: "export {};\n",
      }),
    ).toEqual([`src/view${source}`]);
  },
);

test("an import of a folder finds its index file", async () => {
  expect(
    await importedBy({
      "src/main.ts": 'import "./feature";\n',
      "src/feature/index.ts": "export {};\n",
    }),
  ).toEqual(["src/feature/index.ts"]);
});

test("an import of a parent folder finds the file there", async () => {
  expect(
    await importedBy({
      "src/deep/main.ts": 'import "../shared.ts";\n',
      "src/shared.ts": "export {};\n",
    }),
  ).toEqual(["src/shared.ts"]);
});

test("an exact file name wins over a folder of the same name", async () => {
  expect(
    await importedBy({
      "src/main.ts": 'import "./thing.ts";\n',
      "src/thing.ts": "export {};\n",
      "src/thing.ts.ts": "export {};\n",
    }),
  ).toEqual(["src/thing.ts"]);
});

test("a package import is not listed as an imported file", async () => {
  expect(
    await importedBy({
      "src/main.ts":
        'import { readFile } from "node:fs/promises";\nimport zod from "zod";\nimport "/absolute/helper.ts";\n',
      "src/zod.ts": "export {};\n",
      "src/helper.ts": "export {};\n",
    }),
  ).toEqual([]);
});

test("a relative import of a file outside the inventory is not listed", async () => {
  expect(
    await importedBy({
      "src/main.ts": 'import "./missing.ts";\n',
    }),
  ).toEqual([]);
});

test("a source with no import lists nothing", async () => {
  expect(await importedBy({ "src/main.ts": "export const x = 1;\n" })).toEqual(
    [],
  );
});

test("an empty inventory lists nothing", async () => {
  expect(await importedSources([])).toEqual(new Set());
});

test("each source in the inventory contributes the files it imports", async () => {
  expect(
    await importedBy({
      "src/a.ts": 'import "./c.ts";\n',
      "src/b.ts": 'import "./d.ts";\nimport "./c.ts";\n',
      "src/c.ts": "export {};\n",
      "src/d.ts": "export {};\n",
    }),
  ).toEqual(["src/c.ts", "src/d.ts"]);
});

test.each([
  ["a .tsx file", "src/view.tsx"],
  ["a .jsx file", "src/view.jsx"],
])("%s with markup is scanned for its imports", async (_name, path) => {
  expect(
    await importedBy({
      [path]:
        'import { part } from "./part.ts";\nexport const view = <div>{part}</div>;\n',
      "src/part.ts": "export const part = 1;\n",
    }),
  ).toEqual(["src/part.ts"]);
});

test.each([
  [
    "a .ts file",
    "src/main.ts",
    'import "./helper.ts";\nexport const count: number = 1;\n',
  ],
  [
    "a .tsx file",
    "src/main.tsx",
    'import "./helper.ts";\nexport const count: number = 1;\nexport const view = <div>{count}</div>;\n',
  ],
])(
  "%s with type annotations is scanned for its imports",
  async (_name, path, source) => {
    expect(
      await importedBy({ [path]: source, "src/helper.ts": "export {};\n" }),
    ).toEqual(["src/helper.ts"]);
  },
);

test("a .ts file with an angle-bracket assertion is scanned as plain TypeScript", async () => {
  expect(
    await importedBy({
      "src/main.ts":
        'import "./helper.ts";\nexport const text = <string>"x";\n',
      "src/helper.ts": "export {};\n",
    }),
  ).toEqual(["src/helper.ts"]);
});
