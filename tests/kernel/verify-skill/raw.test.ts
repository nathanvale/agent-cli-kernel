import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  entryOf,
  helperFailures,
  kernelFailures,
  relayed,
  targetFailures,
  verify,
} from "../../../skills/verify-agent-cli/verify.ts";
import type { Bounds } from "../../../skills/verify-agent-cli/verify.ts";
import {
  environment,
  helper,
  helperBound,
  liarEntry,
  releaseWorlds,
  repository,
  stubbornEntry,
  targetEntry,
  world,
} from "./harness.ts";

const small: Bounds = {
  helperMilliseconds: helperBound,
  targetMilliseconds: 5_000,
  graceMilliseconds: 1_000,
  outputBytes: 1_048_576,
};

setDefaultTimeout(
  4 * (small.targetMilliseconds + small.graceMilliseconds) +
    small.helperMilliseconds +
    small.graceMilliseconds +
    helperBound +
    10_000,
);
afterAll(releaseWorlds);

describe("the check that does not go through the kernel", () => {
  test("the kernel loads, so it adds no failure", async () => {
    expect(await kernelFailures()).toEqual([]);
  });

  test("the target's raw exit codes pass for a sound CLI and fail for one that lies", async () => {
    const place = { cwd: repository, env: process.env };
    expect(await targetFailures(targetEntry, place, small)).toEqual([]);
    expect(
      (await targetFailures(liarEntry, place, small)).map(
        (line) => line.split(":")[0],
      ),
    ).toEqual(["target-usage-exit"]);
  });

  test("a helper whose envelope disagrees with its exit code, or prints none, is a raw failure", () => {
    const envelope = (exitCode: number) =>
      `${JSON.stringify({ message: "m", result: { exitCode } })}\n`;
    expect(
      helperFailures({
        exitCode: 3,
        stdout: envelope(3),
        stderr: "",
        stopped: null,
      }),
    ).toEqual([]);
    expect(
      helperFailures({
        exitCode: 0,
        stdout: envelope(3),
        stderr: "",
        stopped: null,
      }),
    ).toEqual([
      "helper-exit-mismatch: the helper's envelope says exit 3, but its process exited 0. Its message: m",
    ]);
    expect(
      helperFailures({
        exitCode: 1,
        stdout: "",
        stderr: "error: boom\n",
        stopped: null,
      }),
    ).toEqual([
      "helper-no-envelope: the helper exited 1 without one envelope on stdout. stderr: error: boom",
    ]);
    expect(
      helperFailures({
        exitCode: null,
        stdout: "",
        stderr: "",
        stopped: "SIGTERM after 5 ms",
      }),
    ).toEqual([
      "helper-stopped: the helper was stopped (SIGTERM after 5 ms) before it answered.",
    ]);
  });

  test("the raw check reads the entry from --entry, else from the run's record, else src/cli.ts", async () => {
    const at = world();
    const place = { cwd: at.repo, env: environment(at) };
    expect(entryOf(["doctor"], place)).toBe(join(at.repo, "src/cli.ts"));
    expect(entryOf(["doctor", "--entry", "bin/x.ts"], place)).toBe(
      join(at.repo, "bin/x.ts"),
    );
    await helper(at, "launch", "r1", "--entry", targetEntry);
    expect(entryOf(["doctor", "--run", "r1"], place)).toBe(targetEntry);
    expect(
      entryOf(["doctor", "--run", "r1", "--entry", "/abs/x.ts"], place),
    ).toBe("/abs/x.ts");
  });

  test("verify runs the raw checks and the helper, and finds nothing wrong with a sound target", async () => {
    const at = world();
    const ran = await verify(
      ["doctor", "--entry", targetEntry],
      { cwd: at.repo, env: environment(at) },
      small,
    );
    expect(ran.failures).toEqual([]);
    expect(ran.helper.exitCode).toBe(0);
  });

  test("the helper's result is relayed as its envelope, its message and data, or one stderr line with its cause", () => {
    const line = (exitCode: number, data: unknown) =>
      `${JSON.stringify({ message: "m", result: { exitCode, causeCode: "C_D", data } })}\n`;
    const ran = (exitCode: number, data: unknown) => ({
      exitCode,
      stdout: line(exitCode, data),
      stderr: "",
      stopped: null,
    });
    expect(relayed(ran(0, { a: 1 }), true)).toEqual({
      stream: "stdout",
      text: line(0, { a: 1 }),
    });
    expect(relayed(ran(0, { a: 1 }), false)).toEqual({
      stream: "stdout",
      text: 'm\n{\n  "a": 1\n}\n',
    });
    expect(relayed(ran(0, null), false)).toEqual({
      stream: "stdout",
      text: "m\n",
    });
    expect(relayed(ran(3, null), false)).toEqual({
      stream: "stderr",
      text: "verify-agent-cli: m [C_D]\n",
    });
  });

  test("a target that ignores SIGTERM is killed when the raw check's grace runs out", async () => {
    const started = performance.now();
    const failures = await targetFailures(
      stubbornEntry,
      { cwd: repository, env: process.env },
      { ...small, targetMilliseconds: 300 },
    );
    expect(performance.now() - started).toBeLessThan(
      2 * (300 + small.graceMilliseconds) + 3_000,
    );
    expect(failures[0]).toStartWith(
      "target-usage-exit: an unknown command exited null, not 2.",
    );
  });
});
