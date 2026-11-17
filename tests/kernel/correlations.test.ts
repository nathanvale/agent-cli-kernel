import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the admitted state specimen validates 27 truth arms and six invalid effect inventories", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-state-"));
  try {
    const source = join(root, "kernel/src");
    await mkdir(join(source, "addons/state"), { recursive: true });
    await cp(
      new URL("../../kernel/src/kernel", import.meta.url),
      join(source, "kernel"),
      { recursive: true },
    );
    const fixture = join(source, "addons/state/qualification.ts");
    await writeFile(
      fixture,
      await readFile(
        new URL("fixtures/state-validator.ts.txt", import.meta.url),
      ),
    );
    const child = Bun.spawn([process.execPath, fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      checks: 4,
      truthRows: 27,
      effectControls: 6,
      custodyControls: 6,
      approvalControls: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
