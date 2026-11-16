import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { materialise } from "./harness.ts";
import { runScenario } from "./swarm-process.ts";

// Swarm-triage expectations that need a state installation (X-K1-4,
// X-K1-10, X-K2S1, X-K2S2, X-K2S3). The installation is a test-only fixture
// in a materialised addons/state folder; each case runs the materialised
// CLI entry as a real child process. Expected values come from the triage
// file's expectations, written from the frozen contract.
const processTimeout = 120_000;
let root = "";
beforeAll(async () => {
  root = await materialise();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function run(
  scenario: string,
  argv: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
) {
  return runScenario(
    scenario,
    argv,
    env,
    join(root, "tests/contract3/kernel-repair/swarm-state-cli.ts"),
  );
}
async function printed(scenario: string, env = {}): Promise<unknown> {
  const observed = await run(scenario, [], env);
  expect({ exit: observed.exit, stderr: observed.stderr }).toEqual({
    exit: 0,
    stderr: "",
  });
  const value: unknown = JSON.parse(observed.stdout);
  return value;
}

test(
  "X-K1-4.ifnoresult-fallback: an ifNoResult step its target cannot parse is refused at declaration",
  async () => {
    // DISC-13: the rule is checked when the command is declared, because
    // the base copies the step into the fallback; DISC-14(1): the named
    // command needs exactly its published literal arguments.
    expect(await printed("ifnoresult-required")).toEqual({
      admission: "refused",
      reason:
        "ifNoResult step specimen.pending [] can never parse: required scope is absent.",
    });
    // Twin: a target with no required slot; the fallback prints exactly one
    // envelope that names it (DISC-11b, LIFE-9).
    const twin = await run("ifnoresult-none", ["apply", "--json"]);
    expect({ exit: twin.exit, stderr: twin.stderr }).toEqual({
      exit: 1,
      stderr: "",
    });
    expect(twin.result).toMatchObject({
      commandIdentity: "specimen.apply",
      causeCode: "INTERNAL_RESULT_UNKNOWN",
      handoff: {
        inspect: [{ kind: "command", command: "specimen.pending", args: [] }],
      },
    });
  },
  processTimeout,
);
