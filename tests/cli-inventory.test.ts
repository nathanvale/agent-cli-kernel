import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  documentationEntries,
  importedSources,
  inventoryApplicationClis,
} from "../src/cli-inventory.ts";
import { processWatchdog, spawnBounded } from "./support/process.ts";
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

const MAIN = 'if (import.meta.main) process.stdout.write("run");\n';

function manifest(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

async function inventoryOf(tree: Tree): Promise<string[]> {
  const root = testFolder("cli-inventory-application-");
  try {
    grown(root, tree);
    return await inventoryApplicationClis(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function failureOf(tree: Tree): Promise<string> {
  const root = testFolder("cli-inventory-failure-");
  try {
    grown(root, tree);
    await inventoryApplicationClis(root);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a repository with no files has no application CLI", async () => {
  expect(await inventoryOf({})).toEqual([]);
});

test("a root that does not exist is refused", async () => {
  const root = testFolder("cli-inventory-missing-");
  rmSync(root, { recursive: true, force: true });
  let code: unknown;
  try {
    await inventoryApplicationClis(root);
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code;
  }
  expect(code).toBe("ENOENT");
});

test("a source that runs when started directly is an application CLI", async () => {
  expect(await inventoryOf({ "src/cli.ts": MAIN })).toEqual(["src/cli.ts"]);
});

test("a source that reads the process arguments is an application CLI", async () => {
  expect(
    await inventoryOf({ "src/cli.ts": "export const args = process.argv;\n" }),
  ).toEqual(["src/cli.ts"]);
});

test("a source that does neither is a library, not a CLI", async () => {
  expect(
    await inventoryOf({ "src/lib.ts": "export const value = 1;\n" }),
  ).toEqual([]);
});

test.each([
  ["a tests folder", "tests/cli.ts"],
  ["a test folder", "test/cli.ts"],
  ["a nested tests folder", "packages/app/tests/cli.ts"],
  ["a fixtures folder", "src/fixtures/cli.ts"],
  ["a proofs folder", "proofs/cli.ts"],
  ["a .test file", "src/cli.test.ts"],
  ["a .spec file", "src/cli.spec.ts"],
  ["a dot-test file", "src/cli.test.mjs"],
])("a source in %s is not an application CLI", async (_where, path) => {
  expect(await inventoryOf({ [path]: MAIN })).toEqual([]);
});

test("a folder that only ends like a test folder still holds application sources", async () => {
  expect(
    await inventoryOf({
      "src/mytests/cli.ts": MAIN,
      "src/latest/main.ts": MAIN,
    }),
  ).toEqual(["src/latest/main.ts", "src/mytests/cli.ts"]);
});

test.each([".ts", ".tsx", ".js", ".mjs", ".mts", ".cts", ".cjs"])(
  "a %s source that runs directly is an application CLI",
  async (extension) => {
    const name = `src/cli${extension}`;
    expect(await inventoryOf({ [name]: MAIN })).toEqual([name]);
  },
);

test.each([".json", ".txt", ".jsx", ".py"])(
  "a %s file is not read as an application source",
  async (extension) => {
    expect(await inventoryOf({ [`src/cli${extension}`]: MAIN })).toEqual([]);
  },
);

test.each([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".worktrees",
  ".fallow",
])("a source under %s is not inventoried", async (folder) => {
  expect(await inventoryOf({ [`${folder}/cli.ts`]: MAIN })).toEqual([]);
});

test("a source under any dot folder is not inventoried", async () => {
  expect(
    await inventoryOf({ ".hidden/cli.ts": MAIN, "src/.cache/cli.ts": MAIN }),
  ).toEqual([]);
});

test("a dot file at the top is not inventoried", async () => {
  expect(await inventoryOf({ ".cli.ts": MAIN })).toEqual([]);
});

test("a symbolic link inside a skipped folder is never inspected", async () => {
  const root = testFolder("cli-inventory-skipped-link-");
  try {
    grown(root, { "src/cli.ts": MAIN, "target.ts": "export {};\n" });
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(root, "target.ts"), join(root, "node_modules/link.ts"));
    expect(await inventoryApplicationClis(root)).toEqual(["src/cli.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symbolic link in the repository is refused by name", async () => {
  const root = testFolder("cli-inventory-link-");
  try {
    grown(root, { "src/cli.ts": MAIN });
    symlinkSync(join(root, "src/cli.ts"), join(root, "src/alias.ts"));
    expect(
      await inventoryApplicationClis(root).then(
        () => "",
        (error: Error) => error.message,
      ),
    ).toBe("CLI inventory cannot inspect symbolic link: src/alias.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root reached through a symbolic link lists entries relative to the real root", async () => {
  const root = testFolder("cli-inventory-real-");
  const via = testFolder("cli-inventory-via-");
  try {
    grown(root, {
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
    });
    const link = join(via, "linked");
    symlinkSync(root, link);
    expect(await inventoryApplicationClis(link)).toEqual(["src/cli.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(via, { recursive: true, force: true });
  }
});

test("a manifest bin string names an application CLI", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
    }),
  ).toEqual(["src/cli.ts"]);
});

test("each manifest bin in an object names an application CLI", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        bin: { one: "src/one.ts", two: "src/two.ts", bad: 3 },
      }),
      "src/one.ts": "export {};\n",
      "src/two.ts": "export {};\n",
    }),
  ).toEqual(["src/one.ts", "src/two.ts"]);
});

test("a manifest script that runs a file names an application CLI", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ scripts: { start: "bun run src/app.ts" } }),
      "src/app.ts": "export {};\n",
    }),
  ).toEqual(["src/app.ts"]);
});

test("a manifest script that runs no file names nothing", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        scripts: { start: "bun run serve", other: 3 },
      }),
    }),
  ).toEqual([]);
});

test("a manifest with no bin and no scripts names nothing", async () => {
  expect(await inventoryOf({ "package.json": "{}" })).toEqual([]);
});

test("a package.json that is not an object names nothing", async () => {
  expect(await inventoryOf({ "package.json": "[1]" })).toEqual([]);
});

test("a tooling script is not an application CLI even when it reads its arguments", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        scripts: { build: "bun scripts/build.ts", start: "bun src/cli.ts" },
      }),
      "scripts/build.ts": "export const args = process.argv;\n",
      "src/cli.ts": "export {};\n",
    }),
  ).toEqual(["src/cli.ts"]);
});

test("a tooling script from a nested package excludes its own file", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
      "packages/lib/package.json": manifest({
        scripts: { "build:docs": "bun tools/docs.ts" },
      }),
      "packages/lib/tools/docs.ts": MAIN,
    }),
  ).toEqual(["src/cli.ts"]);
});

test("a nested package bin is listed relative to the repository root", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
      "packages/lib/package.json": manifest({ bin: { lib: "bin/lib.ts" } }),
      "packages/lib/bin/lib.ts": "export {};\n",
    }),
  ).toEqual(["packages/lib/bin/lib.ts", "src/cli.ts"]);
});

test("a manifest bin that leaves the repository is refused by name", async () => {
  expect(
    await failureOf({
      "package.json": manifest({ bin: "../outside.ts" }),
    }),
  ).toBe("CLI entry leaves the repository: ../outside.ts");
});

test("a manifest bin that names a folder is refused by name", async () => {
  expect(
    await failureOf({
      "package.json": manifest({ bin: "src" }),
      "src/cli.ts": "export {};\n",
    }),
  ).toBe("CLI entry is not an ordinary file: src");
});

test("a manifest bin that names a file that does not exist is refused", async () => {
  expect(
    await failureOf({ "package.json": manifest({ bin: "src/gone.ts" }) }),
  ).toContain("ENOENT");
});

test("a package.json that is not valid JSON is refused", async () => {
  expect(await failureOf({ "package.json": "{" })).toContain(
    "JSON Parse error",
  );
});

test("documentation naming a command that runs a file names an application CLI", async () => {
  expect(
    await inventoryOf({
      "README.md": "Run `bun run src/tool.ts`.\n",
      "src/tool.ts": "export {};\n",
    }),
  ).toEqual(["src/tool.ts"]);
});

test("documentation in a nested package resolves from that package", async () => {
  expect(
    await inventoryOf({
      "package.json": "{}",
      "packages/app/package.json": "{}",
      "packages/app/docs/guide.md": "bun run src/tool.ts\n",
      "packages/app/src/tool.ts": "export {};\n",
    }),
  ).toEqual(["packages/app/src/tool.ts"]);
});

test("documentation naming a tooling script does not list it", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ scripts: { check: "bun scripts/check.ts" } }),
      "README.md": "bun run scripts/check.ts\n",
      "scripts/check.ts": "export {};\n",
    }),
  ).toEqual([]);
});

test("only Markdown files are read as documentation", async () => {
  expect(
    await inventoryOf({
      "NOTES.txt": "bun run src/tool.ts\n",
      "src/tool.ts": "export {};\n",
    }),
  ).toEqual([]);
});

test("a file that several routes name is listed once", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        bin: "src/cli.ts",
        scripts: { start: "bun src/cli.ts" },
      }),
      "README.md": "bun run src/cli.ts\n",
      "src/cli.ts": MAIN,
    }),
  ).toEqual(["src/cli.ts"]);
});

test("entries from every route come back in sorted order", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/b.ts" }),
      "README.md": "bun run src/c.ts\n",
      "src/a.ts": MAIN,
      "src/b.ts": "export {};\n",
      "src/c.ts": "export {};\n",
      "src/d.ts": MAIN,
    }),
  ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
});

test("an executable source that another source imports is still listed", async () => {
  expect(
    await inventoryOf({
      "src/cli.ts": 'import "./second.ts";\n',
      "src/second.ts": MAIN,
    }),
  ).toEqual(["src/second.ts"]);
});

test("a helper that only reads the process arguments for an imported tool is not listed", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ scripts: { build: "bun scripts/build.ts" } }),
      "scripts/build.ts": 'import "./options.ts";\n',
      "scripts/options.ts": "export const args = process.argv;\n",
    }),
  ).toEqual([]);
});

test("a repository with two application CLIs lists both", async () => {
  expect(await inventoryOf({ "src/one.ts": MAIN, "src/two.ts": MAIN })).toEqual(
    ["src/one.ts", "src/two.ts"],
  );
});

test(
  "an entry that is neither a file nor a folder is not inventoried",
  async () => {
    const root = testFolder("cli-inventory-pipe-");
    try {
      grown(root, { "src/cli.ts": MAIN });
      const made = await spawnBounded(["mkfifo", join(root, "src/pipe.ts")]);
      expect(made.exit).toBe(0);
      expect(await inventoryApplicationClis(root)).toEqual(["src/cli.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  processWatchdog(1),
);
