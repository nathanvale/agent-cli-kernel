import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { familyCases } from "./cases.ts";

// Registers one test per frozen case after asserting that the file implements
// exactly the family's active identities: no missing, extra or renamed case.
export function runFamily(
  family: string,
  implementations: Readonly<Record<string, () => unknown>>,
  timeout = 30000,
): void {
  const frozen = familyCases(family).map((item) => item.id);
  test(`${family}: implemented identities equal the frozen active set`, () => {
    expect(frozen.length).toBeGreaterThan(0);
    expect(Object.keys(implementations).sort()).toEqual([...frozen].sort());
  });
  for (const item of familyCases(family)) {
    const run = implementations[item.id];
    test(
      `${item.id}: ${item.expected}`,
      async () => {
        if (!run) throw new Error(`Missing implementation for ${item.id}.`);
        await run();
      },
      timeout,
    );
  }
}

// State fixtures must live in the canonical state add-on folder, so each run
// copies the current kernel into a disposable tree and executes the fixture
// there as a child process. The fixture prints one JSON object of observations.
export async function stateFixture(name: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), "contract3-repair-"));
  try {
    const source = join(directory, "starters/contract3/src");
    await mkdir(join(source, "addons/state"), { recursive: true });
    await cp(
      new URL("../../../starters/contract3/src/kernel", import.meta.url),
      join(source, "kernel"),
      { recursive: true },
    );
    const fixture = join(source, `addons/state/${name}.ts`);
    await writeFile(
      fixture,
      await readFile(new URL(`fixtures/${name}.ts.txt`, import.meta.url)),
    );
    const child = Bun.spawn([process.execPath, fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
