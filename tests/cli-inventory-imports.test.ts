import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { importedSources } from "../src/cli-inventory.ts";
import { grown, type Tree } from "./support/cli-inventory-fixture.ts";
import { testFolder } from "./support/test-folder.ts";

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
