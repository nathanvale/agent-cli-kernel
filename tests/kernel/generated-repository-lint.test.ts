import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ESLint } from "eslint";
import { testFolder } from "../support/test-folder.ts";

const repository = join(import.meta.dir, "../..");
const kernelSource = join(repository, "kernel");
const lintBound = 120_000;
const trees: string[] = [];

afterAll(async () => {
  for (const tree of trees) await rm(tree, { recursive: true, force: true });
});

const planted = {
  "src/app/alias.ts":
    "const runtime = Bun;\nexport const run = runtime.spawnSync;",
  "src/app/script.mjs": 'export const word = "app";',
  "src/app/cause.ts":
    'export const needed = (codes: string[]) => codes.includes("DOMAIN_DEADLINE_UNKNOWN");',
  "src/app/in.ts": 'export const has = (o: object) => "a" in o;',
  "src/app/output.ts": 'export const out = () => process.stdout.write("x");',
  "src/app/locale.ts": 'export const c = "a".localeCompare("b");',
  "src/app/kernel-deep.ts":
    'export { commonCauses } from "../kernel/causes.ts";',
  "src/app/ffi.ts": 'export { dlopen } from "bun:ffi";',
  "src/app/spawn.ts": "export const s = Bun.spawn;",
  "src/app/logging.ts": 'export { getLogger } from "@logtape/logtape";',
  "src/app/predicate.ts":
    'export const isS = (v: unknown): v is string => typeof v === "string";',
  "src/app/child.ts":
    'export const loaded = await import("node:child_process");',
  "src/kernel/validation/planted.ts":
    'export const x = JSON.parse("{}") as Record<string, string>;',
};

const plantedFindings = [
  { file: "src/app/alias.ts", ruleId: "repository/no-process-reach" },
  { file: "src/app/cause.ts", ruleId: "repository/cause-literal-owner" },
  { file: "src/app/child.ts", ruleId: "repository/no-process-reach" },
  { file: "src/app/ffi.ts", ruleId: "no-restricted-imports" },
  { file: "src/app/in.ts", ruleId: "repository/no-in-operator" },
  { file: "src/app/kernel-deep.ts", ruleId: "no-restricted-imports" },
  { file: "src/app/locale.ts", ruleId: "repository/no-locale-compare" },
  { file: "src/app/logging.ts", ruleId: "no-restricted-imports" },
  { file: "src/app/output.ts", ruleId: "repository/no-domain-output" },
  { file: "src/app/predicate.ts", ruleId: "no-restricted-syntax" },
  { file: "src/app/script.mjs", ruleId: "repository/typescript-source" },
  { file: "src/app/spawn.ts", ruleId: "no-restricted-properties" },
  {
    file: "src/kernel/validation/planted.ts",
    ruleId: "no-restricted-syntax",
  },
];

async function hostTree(
  addons: readonly string[],
  folders: readonly string[],
): Promise<string> {
  const tree = testFolder("kernel-generated-repository-lint-");
  trees.push(tree);
  for (const part of ["kernel", "shared"])
    await cp(join(kernelSource, "src", part), join(tree, "src", part), {
      recursive: true,
    });
  for (const name of folders)
    await cp(
      join(kernelSource, "src/addons", name),
      join(tree, "src/addons", name),
      { recursive: true },
    );
  await cp(join(kernelSource, "config/kernel"), join(tree, "config/kernel"), {
    recursive: true,
  });
  for (const [path, text] of Object.entries(planted)) {
    await mkdir(dirname(join(tree, path)), { recursive: true });
    await writeFile(join(tree, path), `${text}\n`);
  }
  await symlink(join(repository, "node_modules"), join(tree, "node_modules"));
  await writeFile(
    join(tree, "tsconfig.json"),
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    join(tree, "eslint.config.mjs"),
    [
      'import { kernelLint } from "./config/kernel/eslint.mjs";',
      "export default kernelLint({",
      "  rootDir: import.meta.dirname,",
      '  srcDir: "src",',
      "  testDirs: [],",
      `  addons: ${JSON.stringify(addons)},`,
      "});",
      "",
    ].join("\n"),
  );
  return tree;
}

async function findings(tree: string, cwd = tree, files = ["."]) {
  const results = await new ESLint({ cwd }).lintFiles(files);
  return results
    .flatMap((result) =>
      result.messages.map((message) => ({
        file: relative(tree, result.filePath),
        ruleId: message.ruleId,
      })),
    )
    .sort((a, b) =>
      `${a.file} ${a.ruleId}` < `${b.file} ${b.ruleId}` ? -1 : 1,
    );
}

describe("kernelLint in a host layout", () => {
  test(
    "every add-on selected: each planted violation is reported once, and stamped source has no finding",
    async () => {
      const tree = await hostTree(
        ["approval", "diagnostics", "menu", "programs", "state"],
        ["approval", "diagnostics", "menu", "programs", "state"],
      );
      expect(await findings(tree)).toEqual(plantedFindings);
    },
    lintBound,
  );

  test(
    "absent add-on folders: approval and state selected, the other two folders missing, the same findings and no error",
    async () => {
      const tree = await hostTree(["approval", "state"], ["approval", "state"]);
      expect(await findings(tree)).toEqual(plantedFindings);
    },
    lintBound,
  );

  test(
    "unselected add-on folders are host-owned: their allowances are off and the two host rules reach them",
    async () => {
      const tree = await hostTree([], ["diagnostics", "state"]);
      const found = await findings(tree);
      for (const finding of [
        {
          file: "src/addons/diagnostics/run.ts",
          ruleId: "no-restricted-imports",
        },
        {
          file: "src/addons/state/linux-flock.ts",
          ruleId: "no-restricted-imports",
        },
        {
          file: "src/addons/diagnostics/io.ts",
          ruleId: "repository/no-in-operator",
        },
      ])
        expect(found).toContainEqual(finding);
      expect(
        found.filter(
          ({ file }) =>
            file.startsWith("src/kernel/") &&
            file !== "src/kernel/validation/planted.ts",
        ),
      ).toEqual([]);
    },
    lintBound,
  );

  test(
    "a host block after kernelLint that sets no-restricted-syntax, as the generated repository's does, keeps the runtime and TypeScript-source refusals",
    async () => {
      const tree = await hostTree([], []);
      await writeFile(
        join(tree, "host.config.mjs"),
        [
          'import { kernelLint } from "./config/kernel/eslint.mjs";',
          "export default [",
          '  ...kernelLint({ rootDir: import.meta.dirname, srcDir: "src", testDirs: [], addons: [] }),',
          '  { files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"], rules: { "no-restricted-syntax": ["error", { selector: "TSAsExpression > TSAsExpression", message: "No chained assertion." }] } },',
          "];",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(tree, "src/app/require-alias.ts"),
        'const load: (id: string) => unknown = require;\nexport const run = (): unknown => load("bun");\n',
      );
      await writeFile(
        join(tree, "src/app/indirect-require.ts"),
        'export const run = (): unknown => (0, require)("bun");\n',
      );
      await writeFile(
        join(tree, "src/app/meta-alias.ts"),
        'const load = import.meta.require;\nexport const run = (): unknown => load("node:child_process");\n',
      );
      await writeFile(
        join(tree, "src/app/meta-key.ts"),
        'export const run = (k: "require"): unknown => import.meta[k]("bun");\n',
      );
      await writeFile(
        join(tree, "src/app/module-import.ts"),
        'import mod from "node:module";\nexport const run = (): unknown => mod.createRequire(import.meta.url)("node:child_process");\n',
      );
      await writeFile(
        join(tree, "src/app/honest-meta.ts"),
        'export const dir = import.meta.dirname;\nexport const listen = (stop: () => void): void => {\n  process.on("SIGINT", stop);\n};\n',
      );
      const startHit =
        "repository/no-process-reach: Contract 3 source starts programs only through the programs add-on.";
      const results = await new ESLint({
        cwd: tree,
        overrideConfigFile: "host.config.mjs",
      }).lintFiles([
        "src/app/alias.ts",
        "src/app/child.ts",
        "src/app/script.mjs",
        "src/app/require-alias.ts",
        "src/app/indirect-require.ts",
        "src/app/meta-alias.ts",
        "src/app/meta-key.ts",
        "src/app/module-import.ts",
        "src/app/honest-meta.ts",
      ]);
      expect(
        results.map((result) => [
          relative(tree, result.filePath),
          result.messages.map(({ ruleId, message }) => `${ruleId}: ${message}`),
        ]),
      ).toEqual([
        ["src/app/alias.ts", [startHit]],
        ["src/app/child.ts", [startHit]],
        [
          "src/app/script.mjs",
          [
            "repository/typescript-source: Source is TypeScript (.ts, .mts or .cts). Repair: write this file as .ts, .mts or .cts.",
          ],
        ],
        ["src/app/require-alias.ts", [startHit]],
        ["src/app/indirect-require.ts", [startHit]],
        ["src/app/meta-alias.ts", [startHit]],
        ["src/app/meta-key.ts", [startHit]],
        ["src/app/module-import.ts", [startHit]],
        ["src/app/honest-meta.ts", []],
      ]);
    },
    lintBound,
  );

  test(
    "a run from a subfolder fails loudly instead of switching cause-literal-owner off",
    async () => {
      const tree = await hostTree(["state"], ["state"]);
      let refusal = "";
      try {
        await findings(tree, join(tree, "src"), ["app/cause.ts"]);
      } catch (error) {
        refusal = String(error);
      }
      expect(refusal).toContain(
        "Run ESLint from the folder that holds eslint.config.mjs.",
      );
    },
    lintBound,
  );
});

describe("cause-literal-owner's owner", () => {
  const noCode = (index: string) =>
    `commonCauses in ${index} names no cause code`;
  for (const [kind, entry, cause] of [
    [
      "is missing",
      undefined,
      (index: string) => `the kernel entry ${index} is missing`,
    ],
    [
      "does not export commonCauses",
      "export const causes = {};",
      (index: string) => `${index} does not export commonCauses`,
    ],
    [
      "exports a commonCauses that names no code",
      "export const commonCauses = {};",
      noCode,
    ],
    [
      "exports a commonCauses whose keys are not cause codes",
      "export const commonCauses = { unrelated: 1 };",
      noCode,
    ],
  ] as const)
    test(
      `a kernel entry that ${kind} fails loudly instead of passing every cause literal`,
      async () => {
        const tree = await hostTree(["state"], ["state"]);
        const index = join(tree, "src/kernel/index.ts");
        if (entry === undefined) await rm(index);
        else await writeFile(index, `${entry}\n`);
        let refusal = "";
        try {
          await findings(tree, tree, ["src/app/cause.ts"]);
        } catch (error) {
          refusal = String(error);
        }
        expect(refusal).toBe(
          [
            `Error: Error while loading rule 'repository/cause-literal-owner': repository/cause-literal-owner cannot learn the cause codes: ${cause(index)}. Repair: install agent-cli-kernel at its Pin again, so its entry exports commonCauses.`,
            `Occurred while linting ${join(tree, "src/app/cause.ts")}`,
          ].join("\n"),
        );
      },
      lintBound,
    );
});

describe("kernelLint settings", () => {
  const full = {
    rootDir: "import.meta.dirname",
    srcDir: '"src"',
    testDirs: "[]",
    addons: '["state"]',
  };
  const kernelLintConfig = (settings: Record<string, string>) =>
    [
      'import { kernelLint } from "./config/kernel/eslint.mjs";',
      "export default kernelLint({",
      ...Object.entries(settings).map(([key, value]) => `  ${key}: ${value},`),
      "});",
      "",
    ].join("\n");

  async function refusal(tree: string, name: string, text: string) {
    const file = `${name}.config.mjs`;
    await writeFile(join(tree, file), text);
    try {
      const results = await new ESLint({
        cwd: tree,
        overrideConfigFile: file,
      }).lintFiles(["src/app/cause.ts"]);
      const messages = results.flatMap((result) => result.messages);
      return `no refusal: ${messages.map(({ message }) => message).join(" ")}`;
    } catch (error) {
      return String(error);
    }
  }

  for (const name of Object.keys(full))
    test(
      `a missing ${name} fails loudly`,
      async () => {
        const tree = await hostTree(["state"], ["state"]);
        const rest = Object.fromEntries(
          Object.entries(full).filter(([key]) => key !== name),
        );
        expect(
          await refusal(tree, `missing-${name}`, kernelLintConfig(rest)),
        ).toContain(`kernelLint needs ${name}`);
      },
      lintBound,
    );

  for (const [name, value, kind] of [
    ["rootDir", '"."', "a relative rootDir"],
    ["srcDir", '"src/"', "a srcDir that ends in a slash"],
    ["testDirs", '["tests", ""]', "a testDirs entry that is empty"],
    ["addons", '"state"', 'addons that is neither "all" nor a list'],
  ] as const)
    test(
      `${kind} fails loudly`,
      async () => {
        const tree = await hostTree(["state"], ["state"]);
        expect(
          await refusal(
            tree,
            `refused-${name}`,
            kernelLintConfig({ ...full, [name]: value }),
          ),
        ).toContain(`kernelLint needs ${name}: `);
      },
      lintBound,
    );

  test(
    "an add-on the kernel does not declare fails loudly",
    async () => {
      const tree = await hostTree(["state"], ["state"]);
      expect(
        await refusal(
          tree,
          "unknown-addon",
          kernelLintConfig({ ...full, addons: '["stat"]' }),
        ),
      ).toContain('kernelLint: add-on "stat" is not declared');
    },
    lintBound,
  );

  test(
    "a plugin that replaces a kernel rule fails loudly",
    async () => {
      const tree = await hostTree(["state"], ["state"]);
      const replaced = [
        'import kernel from "./config/kernel/eslint-rules.mjs";',
        'const plugin = { rules: { ...kernel.rules, "no-locale-compare": { ...kernel.rules["no-locale-compare"] } } };',
        kernelLintConfig({ ...full, plugin: "plugin" }),
      ].join("\n");
      expect(await refusal(tree, "replaced-rule", replaced)).toContain(
        "kernelLint: the plugin must hold the kernel's own no-locale-compare rule",
      );
    },
    lintBound,
  );

  test(
    "cause-literal-owner without settings.kernel.srcDir fails loudly",
    async () => {
      const tree = await hostTree(["state"], ["state"]);
      const bare = [
        'import repository from "./config/kernel/eslint-rules.mjs";',
        'import tseslint from "typescript-eslint";',
        "export default [{",
        '  files: ["**/*.ts"],',
        "  languageOptions: {",
        "    parser: tseslint.parser,",
        "    parserOptions: { tsconfigRootDir: import.meta.dirname },",
        "  },",
        "  plugins: { repository },",
        '  rules: { "repository/cause-literal-owner": "error" },',
        "}];",
        "",
      ].join("\n");
      expect(await refusal(tree, "bare-rule", bare)).toContain(
        "repository/cause-literal-owner needs settings.kernel.srcDir",
      );
    },
    lintBound,
  );
});
