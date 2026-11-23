import { expect } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
