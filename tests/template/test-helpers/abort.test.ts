import { expect, test } from "bun:test";
import { join } from "node:path";
import { spawnBounded } from "../../kernel/kernel-repair/swarm-process.ts";

const fixture = join(import.meta.dir, "fixtures", "core-limit.ts");

async function coreLimitSeenBy(mode: "off" | "as-is"): Promise<string> {
  const run = await spawnBounded([
    "sh",
    "-c",
    'ulimit -S -c unlimited && exec "$0" "$1" "$2"',
    process.execPath,
    fixture,
    mode,
  ]);
  expect(run).toMatchObject({ exit: 0, stderr: "" });
  return run.stdout;
}

test("a process that turns core dumps off before a planted abort leaves its children no core limit to dump into", async () => {
  expect(await coreLimitSeenBy("as-is")).toBe("unlimited");
  expect(await coreLimitSeenBy("off")).toBe("0");
});
