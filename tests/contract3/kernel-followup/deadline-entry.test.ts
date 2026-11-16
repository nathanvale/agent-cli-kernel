import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { emptyComplete, materialiseKf, oneEnvelope, runKf } from "./harness.ts";
import type { KfRun } from "./harness.ts";

// Delta-2 review follow-up F1 (K3-spec-1): the deadline is re-checked at
// handler entry. LIFE-6 ("At the deadline the command stops starting
// work"), the lifecycle row "Deadline before operation dispatch" read as
// before handler entry, WIRE-15, CMD-9 steps 4 to 6. The window is opened by
// a synchronous block (a stated proof gap: an I/O completion handled before
// the expired timer opens the same window and is not reproduced). Expected
// values come from expectations.md (KF7).
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

// Independent oracle: the base's fixed DOMAIN_DEADLINE_BEFORE_START words
// (WIRE-18 N; accepted wording).
const beforeStartNext = {
  kind: "instruction",
  text: "Inspect the deadline and the input, then explicitly decide whether to start a new run.",
};
function expectBeforeStart(run: KfRun, identity: string) {
  expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
    exit: 3,
    one: true,
  });
  expect(run.envelope).not.toHaveProperty("diagnostics");
  expect(run.result).not.toHaveProperty("handoff");
  expect(run.result).toMatchObject({
    commandIdentity: identity,
    causeCode: "DOMAIN_DEADLINE_BEFORE_START",
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    effects: emptyComplete,
    next: beforeStartNext,
  });
  expect(run.ledger).not.toContain("handler-entered");
  expect(run.ledger.some((line) => line.startsWith("effect-applied"))).toBe(
    false,
  );
}

describe("KF7.a check-settles-after-deadline", () => {
  for (const [variant, scenario, verb, identity, success] of [
    ["inspect", "read", "read", "kf.read", "SUCCESS_UNCHANGED"],
    ["changing", "apply-approved", "apply", "kf.apply", "SUCCESS_COMPLETED"],
  ] as const)
    test(
      `KF7.a ${variant}: a check that blocks past the deadline never reaches the handler`,
      async () => {
        const run = await runKf(
          entry,
          scenario,
          [verb, "--deadline-ms", "50", "--json"],
          { KF_APPROVAL: "grant", KF_CHECK_BLOCK: "200" },
        );
        expectBeforeStart(run, identity);
        // The ledger is wired: the check ran; nothing attached after it.
        expect(run.ledger).toContain("check-start");
        expect(run.ledger).not.toContain("attach state");
        // Twin: a short block well inside a longer deadline enters once.
        const twin = await runKf(
          entry,
          scenario,
          [verb, "--deadline-ms", "500", "--json"],
          { KF_APPROVAL: "grant", KF_CHECK_BLOCK: "30" },
        );
        expect(twin.exit).toBe(0);
        expect(twin.result?.causeCode).toBe(success);
        expect(
          twin.ledger.filter((line) => line === "handler-entered"),
        ).toEqual(["handler-entered"]);
      },
      processWatchdog(2),
    );
});

test(
  "KF7.b attach-outlasts-deadline: a state attach that blocks past the deadline never reaches the handler",
  async () => {
    const run = await runKf(
      entry,
      "apply",
      ["apply", "--deadline-ms", "50", "--json"],
      {
        KF_STATE_ATTACH_BLOCK: "200",
      },
    );
    expectBeforeStart(run, "kf.apply");
    // The attach itself is the trigger, so its line is present.
    expect(run.ledger).toEqual(["attach state"]);
    const twin = await runKf(
      entry,
      "apply",
      ["apply", "--deadline-ms", "500", "--json"],
      { KF_STATE_ATTACH_BLOCK: "30" },
    );
    expect(twin.exit).toBe(0);
    expect(twin.result?.causeCode).toBe("SUCCESS_COMPLETED");
    expect(twin.ledger).toEqual([
      "attach state",
      "handler-entered",
      "effect-applied kf.e",
    ]);
  },
  processWatchdog(2),
);
