import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EXPECTED_COMPILER_OPTIONS,
  EXPECTED_DEPENDENCY_PINS,
  EXPECTED_FILES,
  EXPECTED_SCRIPTS,
  SELECTED_FALLOW_RULES,
} from "../../support/static-admission-policy.ts";
import {
  createProjectFixture,
  type Profile,
  readJson,
  runAdmission,
  writeJson,
} from "../../support/static-admission-project.ts";

const createProject = createProjectFixture();

async function expectAdmissionRefusal(
  root: string,
  profile: Profile,
  cause: string,
): Promise<void> {
  const observed = await runAdmission(root, profile);
  expect(observed.invocation.stderr).toBe("");
  expect(observed.invocation.exitCode).toBe(1);
  expect(observed.result.status).toBe("refused");
  expect(observed.result.cause).toBe(cause);
}

interface PolicyMutation {
  file: string;
  path: string[];
  cause: string;
  replacement?: unknown;
}

function compilerMutations(): PolicyMutation[] {
  return Object.keys(EXPECTED_COMPILER_OPTIONS).map((option) => ({
    file: "tsconfig.base.json",
    path: ["compilerOptions", option],
    cause: `policy:tsconfig.base.json.compilerOptions.${option}`,
  }));
}

function packageMutations(profile: Profile): PolicyMutation[] {
  const mutations: PolicyMutation[] = [
    {
      file: "package.json",
      path: ["overrides"],
      cause: "policy:package.json.overrides",
    },
    {
      file: "bun.lock",
      path: ["overrides"],
      cause: "policy:bun.lock.overrides",
    },
    {
      file: "bun.lock",
      path: ["packages", "@typescript/old"],
      replacement: ["typescript@6.0.3"],
      cause: "policy:bun.lock.packages.@typescript/old",
    },
    {
      file: "package.json",
      path: ["packageManager"],
      cause: "policy:package.json.packageManager",
    },
    {
      file: "package.json",
      path: ["private"],
      replacement: false,
      cause: "policy:package.json.private",
    },
    {
      file: "package.json",
      path: ["type"],
      replacement: "commonjs",
      cause: "policy:package.json.type",
    },
  ];
  for (const group of ["dependencies", "devDependencies"] as const) {
    for (const name of Object.keys(EXPECTED_DEPENDENCY_PINS[profile][group])) {
      mutations.push(
        {
          file: "package.json",
          path: [group, name],
          cause: `policy:package.json.${group}.${name}`,
        },
        {
          file: "bun.lock",
          path: ["workspaces", "", group, name],
          cause: `policy:bun.lock.workspaces.root.${group}.${name}`,
        },
        {
          file: "bun.lock",
          path: ["packages", name],
          cause: `policy:bun.lock.packages.${name}`,
        },
      );
    }
  }
  return mutations;
}

function biomeMutations(): PolicyMutation[] {
  return [
    {
      file: "biome.json",
      path: ["linter", "enabled"],
      replacement: true,
      cause: "policy:biome.json.linter.enabled",
    },
    {
      file: "biome.json",
      path: ["assist", "enabled"],
      replacement: true,
      cause: "policy:biome.json.assist.enabled",
    },
    {
      file: "biome.json",
      path: ["formatter", "enabled"],
      replacement: false,
      cause: "policy:biome.json.formatter.enabled",
    },
    {
      file: "biome.json",
      path: ["files", "includes"],
      replacement: ["src/**/*.ts"],
      cause: "policy:biome.json.files.includes",
    },
  ];
}

function fallowMutations(): PolicyMutation[] {
  const mutations: PolicyMutation[] = [];
  for (const rule of SELECTED_FALLOW_RULES) {
    for (const replacement of [undefined, "off"])
      mutations.push({
        file: ".fallowrc.json",
        path: ["rules", rule],
        replacement,
        cause: `policy:.fallowrc.json.rules.${rule}`,
      });
  }
  mutations.push(
    {
      file: ".fallowrc.json",
      path: ["entry"],
      replacement: ["src/cli.ts"],
      cause: "policy:.fallowrc.json.entry",
    },
    {
      file: ".fallowrc.json",
      path: ["ignorePatterns"],
      replacement: ["src/**/*.ts"],
      cause: "policy:.fallowrc.json.ignorePatterns",
    },
    {
      file: ".fallowrc.json",
      path: ["boundaries", "coverage", "requireAllFiles"],
      replacement: false,
      cause: "policy:.fallowrc.json.boundaries.coverage.requireAllFiles",
    },
    {
      file: ".fallowrc.json",
      path: ["typeAware", "require"],
      replacement: "best-effort",
      cause: "policy:.fallowrc.json.typeAware.require",
    },
    {
      file: "package.json",
      path: ["scripts", "quality:fallow"],
      replacement:
        "node_modules/.bin/fallow audit --format json --quiet --gate new-only --type-aware --type-aware-require complete",
      cause: "policy:package.json.scripts.quality:fallow",
    },
    {
      file: "package.json",
      path: ["scripts", "quality:fallow"],
      replacement: EXPECTED_SCRIPTS.quality.replace(
        "require complete",
        "require best-effort",
      ),
      cause: "policy:package.json.scripts.quality:fallow",
    },
    {
      file: "package.json",
      path: ["scripts", "quality:fallow:dependencies"],
      replacement: EXPECTED_SCRIPTS.dependencies.replace(
        "require complete",
        "require best-effort",
      ),
      cause: "policy:package.json.scripts.quality:fallow:dependencies",
    },
  );
  return mutations;
}

async function mutatePolicy(
  root: string,
  mutation: PolicyMutation,
): Promise<void> {
  const path = join(root, mutation.file);
  const data = Bun.JSONC.parse(await Bun.file(path).text()) as Record<
    string,
    unknown
  >;
  let owner = data;
  const keys = [...mutation.path];
  const last = keys.pop();
  if (!last) throw new Error("Mutation missing final key");
  for (const key of keys) owner = owner[key] as Record<string, unknown>;
  if (mutation.replacement === undefined) delete owner[last];
  else owner[last] = mutation.replacement;
  await writeJson(path, data);
}

for (const profile of ["simple", "complex"] as const) {
  const groups = {
    compiler: compilerMutations(),
    packages: packageMutations(profile),
    biome: biomeMutations(),
    fallow: fallowMutations(),
    includes: [
      {
        file: "tsconfig.json",
        path: ["include"],
        replacement: ["src/**/*.ts"],
        cause: "policy:tsconfig.json.include",
      },
      {
        file: "tsconfig.json",
        path: ["include"],
        replacement: ["tests/**/*.ts"],
        cause: "policy:tsconfig.json.include",
      },
    ],
  };
  for (const [group, mutations] of Object.entries(groups)) {
    for (const [index, mutation] of mutations.entries()) {
      test(`admission weakening matrix: ${profile} ${group} ${index + 1} ${mutation.cause}`, async () => {
        const root = await createProject(profile);
        await mutatePolicy(root, mutation);
        await expectAdmissionRefusal(root, profile, mutation.cause);
      }, 120_000);
    }
  }
}

for (const profile of ["simple", "complex"] as const) {
  for (const excluded of EXPECTED_FILES[profile]) {
    test(`admission excludes no authored file: ${profile} ${excluded}`, async () => {
      const root = await createProject(profile);
      const config = await readJson(join(root, "tsconfig.json"));
      config.exclude = [excluded];
      await writeJson(join(root, "tsconfig.json"), config);
      await expectAdmissionRefusal(
        root,
        profile,
        "policy:tsconfig.json.exclude",
      );
    }, 120_000);
  }
  for (const contract of ["tsconfig.json", "tsconfig.base.json"]) {
    test(`admission requires type contract: ${profile} ${contract}`, async () => {
      const root = await createProject(profile);
      await rm(join(root, contract));
      await expectAdmissionRefusal(root, profile, `file:missing:${contract}`);
    }, 120_000);
  }
}

test("admission rejects an authored file outside the include owners", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "outside.ts"),
    "export type ContractLock = string;\n",
  );
  await expectAdmissionRefusal(
    root,
    "complex",
    "scope:outside-includes:outside.ts",
  );
}, 120_000);
