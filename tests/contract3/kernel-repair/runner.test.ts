import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBounded } from "./swarm-process.ts";

// Delta F6: the bounded runner's release path, shown on a child that never
// exits within its bound. A 100 ms bound keeps the case cheap; the child's own
// 8 s exit only guarantees no leftover process if the kill were removed.
test("F6.bounded-runner-releases-a-hang: a child past its bound is killed and the run fails naming the bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contract3-runner-"));
  try {
    const pidFile = join(directory, "pid");
    const source = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 8000);`;
    let failure = "resolved";
    try {
      await spawnBounded([process.execPath, "-e", source], {
        boundMilliseconds: 100,
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toEndWith("did not exit within 100 ms.");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    // The child is gone: signal 0 to a dead pid throws ESRCH.
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
