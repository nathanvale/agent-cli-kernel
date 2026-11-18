import { expect, test } from "bun:test";
import { spawnBounded } from "./support/process.ts";

function failure(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => "exited",
    (error: unknown) => String(error),
  );
}

test("spawnBounded names a child that is still running when its bound passes", async () => {
  const outcome = await failure(
    spawnBounded(["sh", "-c", "sleep 31; true"], {
      boundMilliseconds: 300,
      processGroup: true,
    }),
  );

  expect(outcome).toStartWith(
    "Error: sh -c sleep 31; true did not exit within 300 ms.\nProcesses left when the bound passed:\n",
  );
  expect(outcome).toMatch(
    /\n\d+ +\d+ +\d+ +\S+ +[\d:.-]+ +sh -c sleep 31; true/,
  );
  expect(outcome).not.toContain("had exited");
}, 10_000);

test("spawnBounded names the process that outlives an exited child and holds its output open", async () => {
  const outcome = await failure(
    spawnBounded(["sh", "-c", "sleep 32 & exit 0"], {
      boundMilliseconds: 300,
      processGroup: true,
    }),
  );

  expect(outcome).toContain("did not exit within 300 ms.\n");
  expect(outcome).toMatch(/\n\d+ had exited\n/);
  expect(outcome).toMatch(/\n\d+ +\d+ +\d+ +\S+ +[\d:.-]+ +sleep 32/);
}, 10_000);

test("spawnBounded returns the output and exit code of a child inside its bound", async () => {
  expect(
    await spawnBounded(["sh", "-c", "printf out; printf err >&2; exit 3"]),
  ).toEqual({ stdout: "out", stderr: "err", exit: 3 });
});
