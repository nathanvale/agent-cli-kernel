import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import ts from "typescript";
import {
  closeArgs,
  expectCompleted,
  makeWorld,
  only,
  supportingTest,
} from "./harness.ts";
import type { Run, World } from "./harness.ts";

const apply = (name: string) => ["apply", name, "--content", "v1", "--json"];

const leaves = ["format", "intent", "events", "closure"] as const;
type Leaf = (typeof leaves)[number];

async function within(body: (world: World) => Promise<void>): Promise<void> {
  const world = makeWorld({ qualification: "fixture" });
  try {
    await body(world);
  } finally {
    world.dispose();
  }
}

async function closedCase(world: World): Promise<string> {
  await world.killAt(apply("a"), "effect");
  const id = only(world);
  expectCompleted(await world.run(closeArgs(id, await world.revision(id))));
  return id;
}

function leafPath(world: World, id: string, leaf: Leaf): string {
  return leaf === "format"
    ? join(world.root, "format")
    : join(world.root, "operations", id, leaf);
}

function replaceLeaf(
  world: World,
  path: string,
  leaf: Leaf,
  form: "regular" | "linked",
): void {
  const bytes = readFileSync(path);
  rmSync(path);
  if (form === "regular") writeFileSync(path, bytes, { mode: 0o600 });
  else {
    const outside = join(world.base, "outside", leaf);
    mkdirSync(join(world.base, "outside"), { recursive: true });
    writeFileSync(outside, bytes, { mode: 0o600 });
    symlinkSync(outside, path);
  }
  expect(lstatSync(path).isSymbolicLink()).toBe(form === "linked");
  expect(readFileSync(path).equals(bytes)).toBe(true);
}

async function readingRoutes(
  world: World,
  id: string,
): Promise<Readonly<Record<string, Run>>> {
  return {
    history: await world.history(id),
    pending: await world.run(["pending", "--json"]),
    admission: await world.run(apply("b")),
  };
}

const outcomes = (runs: Readonly<Record<string, Run>>) =>
  Object.fromEntries(
    Object.entries(runs).map(([route, run]) => [route, run.result.outcome]),
  );

for (const leaf of leaves) {
  supportingTest(
    `journal file links: a regular ${leaf} with valid bytes is accepted by history, pending and admission`,
    () =>
      within(async (world) => {
        const id = await closedCase(world);
        replaceLeaf(world, leafPath(world, id, leaf), leaf, "regular");
        const runs = await readingRoutes(world, id);
        expect(outcomes(runs)).toEqual({
          history: "success",
          pending: "success",
          admission: "success",
        });
        if (runs.admission) expectCompleted(runs.admission);
        expect(world.noteLedger("b")).toBe(1);
      }),
  );

  supportingTest(
    `journal file links: a ${leaf} that is a symbolic link to identical bytes outside the root is refused by history, pending and admission`,
    () =>
      within(async (world) => {
        const id = await closedCase(world);
        replaceLeaf(world, leafPath(world, id, leaf), leaf, "linked");
        const runs = await readingRoutes(world, id);
        expect(outcomes(runs)).toEqual({
          history: "refused",
          pending: "refused",
          admission: "refused",
        });
        expect(world.noteLedger("b")).toBe(0);
      }),
  );
}

const stateSource = resolve(
  import.meta.dir,
  "../../../kernel/src/addons/state",
);
const fileReaders = new Set(["readFileSync", "readFile", "createReadStream"]);

function fsDeclared(declaration: ts.Declaration | undefined): boolean {
  const file = declaration?.getSourceFile().fileName ?? "";
  return /\/node_modules\/(@types\/node|bun-types)\/.*fs/.test(file);
}

function fileReadCalls(): string[] {
  const files = readdirSync(stateSource)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(stateSource, name));
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    types: ["bun"],
  });
  const checker = program.getTypeChecker();
  const found: string[] = [];
  for (const path of files) {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`The compiler did not load ${path}.`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        const name =
          declaration && ts.isFunctionDeclaration(declaration)
            ? declaration.name?.text
            : undefined;
        if (name && fileReaders.has(name) && fsDeclared(declaration))
          found.push(
            `${basename(path)}: ${node.getText(source).replace(/\s+/g, " ")}`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test("journal file links: every file read in the state add-on reads an open descriptor, except the host boot identity", () => {
  expect(fileReadCalls()).toEqual([
    'qualification.ts: readFileSync(bootIdentitySource, "utf8")',
    "store.ts: readFileSync(descriptor)",
  ]);
});
