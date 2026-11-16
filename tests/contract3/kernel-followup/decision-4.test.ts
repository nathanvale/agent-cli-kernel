import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { materialiseKf, oneEnvelope, runKf } from "./harness.ts";

// Accepted decision "Contract question 6 of 8" (K1-spec-11): at declaration
// every declared command step must route to the command it names
// (`resolve(route ++ args)` selects the target). INPUT-3, STEP-6, STEP-12,
// DISC-13, CMD-9 step 2. Expected values come from expectations.md (KF4).
let entry = "";
beforeAll(async () => {
  entry = await materialiseKf();
});
afterAll(async () => {
  await rm(join(dirname(entry), "../../../.."), {
    recursive: true,
    force: true,
  });
});

async function admission(step: string, args: readonly string[]) {
  const run = await runKf(entry, "step-admission", [], {
    KF_STEP: step,
    KF_ARGS: JSON.stringify(args),
  });
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({
    exit: 0,
    stderr: "",
  });
  const value: unknown = JSON.parse(run.stdout);
  return value;
}

describe("KF4.a literal-step-reroutes-refused", () => {
  // Each refused variant: the named refusal names the step's target, its
  // args and where they route instead.
  const refused = [
    [
      "next",
      ["all"],
      'Command step kf.list ["all"] from kf.go routes to kf.list-all.',
    ],
    [
      "inspect-entry",
      ["all"],
      'Command step kf.list ["all"] from kf.go routes to kf.list-all.',
    ],
    [
      "if-no-result",
      ["all"],
      'ifNoResult step kf.pending ["all"] routes to kf.pending-all.',
    ],
    [
      "root",
      ["list"],
      'Command step kf.root ["list"] from kf.go routes to kf.list.',
    ],
    [
      "deep",
      ["b", "c"],
      'Command step kf.a ["b","c"] from kf.go routes to kf.a-b-c.',
    ],
  ] as const;
  for (const [step, args, reason] of refused)
    test(
      `KF4.a ${step}: a step that routes elsewhere is refused at declaration`,
      async () => {
        expect(await admission(step, args)).toEqual({
          admission: "refused",
          reason,
        });
      },
      processWatchdog(1),
    );
  test(
    "KF4.a twins: steps that route to their target are admitted",
    async () => {
      for (const [step, args] of [
        ["next", ["mine"]],
        ["next", ["--", "all"]],
        ["next", ["list"]],
        ["deep", ["b"]],
        ["next", ["{binding.scope}"]],
        ["if-no-result", ["mine"]],
      ] as const)
        expect({ step, args, admission: await admission(step, args) }).toEqual({
          step,
          args,
          admission: { admission: "admitted" },
        });
    },
    processWatchdog(6),
  );
  test(
    "KF4.a process twins: the emitted step runs as kf.list",
    async () => {
      for (const [args, operand] of [
        [["mine"], "mine"],
        [["--", "all"], "all"],
        [["list"], "list"],
      ] as const) {
        const env = { KF_STEP: "next", KF_ARGS: JSON.stringify(args) };
        const go = await runKf(entry, "steps", ["go", "--json"], env);
        expect(go.exit).toBe(0);
        const next = go.result?.next;
        expect(next).toEqual({ kind: "command", command: "kf.list", args });
        // The step's final vector with --json placed before any `--`.
        const followed = await runKf(
          entry,
          "steps",
          ["list", "--json", ...args],
          env,
        );
        expect({ exit: followed.exit, one: oneEnvelope(followed) }).toEqual({
          exit: 0,
          one: true,
        });
        expect(followed.result).toMatchObject({
          commandIdentity: "kf.list",
          causeCode: "SUCCESS_UNCHANGED",
          data: { operands: [operand] },
        });
      }
    },
    processWatchdog(6),
  );
});

// KF4.b: the rule is where the vector routes, not token equality. The
// ["list"] and ["--", "all"] twins above pin it (a literal equal to a route
// token is admitted when the vector still routes to its target).
test(
  "KF4.b rule-is-resolution-not-token-equality",
  async () => {
    expect(await admission("next", ["list"])).toEqual({
      admission: "admitted",
    });
    expect(await admission("next", ["--", "all"])).toEqual({
      admission: "admitted",
    });
  },
  processWatchdog(2),
);
