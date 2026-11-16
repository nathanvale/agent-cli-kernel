import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import {
  emptyComplete,
  humanOneLine,
  materialiseKf,
  oneEnvelope,
  runKf,
} from "./harness.ts";
import type { KfRun } from "./harness.ts";

// Accepted decision "Contract question 3 of 8" (K3-spec-5): an add-on that
// throws while the kernel attaches it before handler entry is a preparation
// fault. LIFE-1, WIRE-15 (refused, unchanged, internal, exit 1), WIRE-18
// INTERNAL_PREPARATION (N), LIFE-9 step 1, CMD-9 step 6. Expected values come
// from expectations.md (KF1), written from the frozen contract.
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

// Independent oracle: the base's fixed INTERNAL_PREPARATION words (WIRE-18
// "N: repair the CLI or runtime before another run"; accepted wording).
const preparationNext = {
  kind: "instruction",
  text: "Repair the CLI or its runtime, then decide whether to start another run.",
};
function expectPreparation(run: KfRun, identity: string) {
  expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
    exit: 1,
    one: true,
  });
  expect(run.envelope).not.toHaveProperty("diagnostics");
  expect(run.result).not.toHaveProperty("retryDelayMilliseconds");
  expect(run.result).not.toHaveProperty("handoff");
  expect(run.result).toMatchObject({
    commandIdentity: identity,
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "internal",
    exitCode: 1,
    causeCode: "INTERNAL_PREPARATION",
    retryable: false,
    data: null,
    effects: emptyComplete,
    next: preparationNext,
  });
  expect(run.ledger).not.toContain("handler-entered");
  expect(run.ledger).not.toContain("check-start");
  expect(run.ledger.some((line) => line.startsWith("effect-applied"))).toBe(
    false,
  );
}

describe("KF1.a approval-attach-relative-directory", () => {
  test(
    "KF1.a inspect: the shipped approval add-on given a relative directory refuses as a preparation fault",
    async () => {
      const run = await runKf(entry, "read", ["read", "--json"], {
        KF_APPROVAL: "shipped",
        KF_GRANTS: "relative/grants",
      });
      expectPreparation(run, "kf.read");
      // Twin: an absolute, empty grant store denies after the check started
      // (accepted decision B3: owner human).
      const store = join(dirname(entry), "grants-inspect");
      await mkdir(store);
      const twin = await runKf(entry, "read", ["read", "--json"], {
        KF_APPROVAL: "shipped",
        KF_GRANTS: store,
      });
      expect({ exit: twin.exit, one: oneEnvelope(twin) }).toEqual({
        exit: 3,
        one: true,
      });
      expect(twin.result).toMatchObject({
        causeCode: "DOMAIN_AUTHORITY_REQUIRED",
        outcome: "refused",
        transactionState: "unchanged",
        handoff: { owner: "human" },
      });
      expect(twin.result).not.toHaveProperty("next");
      expect(twin.ledger).toContain("check-start");
      expect(twin.ledger).not.toContain("handler-entered");
    },
    processWatchdog(2),
  );
  test(
    "KF1.a changing: the same fault on a changing command attaches no state and records no intent",
    async () => {
      const run = await runKf(entry, "apply-approved", ["apply", "--json"], {
        KF_APPROVAL: "shipped",
        KF_GRANTS: "relative/grants",
      });
      expectPreparation(run, "kf.apply");
      expect(run.ledger).not.toContain("attach state");
      const store = join(dirname(entry), "grants-changing");
      await mkdir(store);
      const twin = await runKf(entry, "apply-approved", ["apply", "--json"], {
        KF_APPROVAL: "shipped",
        KF_GRANTS: store,
      });
      expect(twin.exit).toBe(3);
      expect(twin.result).toMatchObject({
        causeCode: "DOMAIN_AUTHORITY_REQUIRED",
        handoff: { owner: "human" },
      });
      expect(twin.ledger).toContain("check-start");
      expect(twin.ledger).not.toContain("handler-entered");
    },
    processWatchdog(2),
  );
  test(
    "KF1.a human-inspect: human mode prints one line on stderr and exits 1",
    async () => {
      const run = await runKf(entry, "read", ["read"], {
        KF_APPROVAL: "shipped",
        KF_GRANTS: "relative/grants",
      });
      expect({ exit: run.exit, oneLine: humanOneLine(run) }).toEqual({
        exit: 1,
        oneLine: true,
      });
      expect(run.ledger).not.toContain("handler-entered");
    },
    processWatchdog(1),
  );
});

describe("KF1.b host-attach-throw-forms", () => {
  for (const variant of ["sync-throw", "reject"] as const)
    test(
      `KF1.b ${variant}: a host approval attach fault refuses as a preparation fault`,
      async () => {
        const run = await runKf(entry, "read", ["read", "--json"], {
          KF_APPROVAL: variant,
        });
        expectPreparation(run, "kf.read");
      },
      processWatchdog(1),
    );
  test(
    "KF1.b twin: an attach that succeeds and a granting check enter the handler once",
    async () => {
      const run = await runKf(entry, "read", ["read", "--json"], {
        KF_APPROVAL: "grant",
      });
      expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
        exit: 0,
        one: true,
      });
      expect(run.result).toMatchObject({ causeCode: "SUCCESS_UNCHANGED" });
      expect(run.ledger.filter((line) => line === "handler-entered")).toEqual([
        "handler-entered",
      ]);
    },
    processWatchdog(1),
  );
});

test(
  "KF1.c state-attach-throw: a state attach fault at CMD-9 step 6 refuses before handler entry",
  async () => {
    const run = await runKf(entry, "apply", ["apply", "--json"], {
      KF_STATE_ATTACH: "throw",
    });
    expectPreparation(run, "kf.apply");
    // The ledger is wired: the attach itself was attempted.
    expect(run.ledger).toEqual(["attach state"]);
    // Twin: the attach succeeds and the handler completes kf.e under a proof.
    const twin = await runKf(entry, "apply", ["apply", "--json"]);
    expect({ exit: twin.exit, one: oneEnvelope(twin) }).toEqual({
      exit: 0,
      one: true,
    });
    expect(twin.result).toMatchObject({
      causeCode: "SUCCESS_COMPLETED",
      effects: { ...emptyComplete, completed: ["kf.e"] },
    });
    expect(twin.ledger).toEqual([
      "attach state",
      "handler-entered",
      "effect-applied kf.e",
    ]);
  },
  processWatchdog(2),
);

test(
  "KF1.e deferred-attach-after-entry: a first-use attach that rejects inside the handler is a handler fault",
  async () => {
    // LIFE-9 step 1, after handler entry: an inspect command keeps its
    // inspect and unchanged stance.
    const run = await runKf(entry, "run", ["run", "--json"], {
      KF_PROGRAMS_ATTACH: "reject",
    });
    expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
      exit: 1,
      one: true,
    });
    expect(run.result).toMatchObject({
      commandIdentity: "kf.run",
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      outcome: "failed",
      transactionState: "unchanged",
      failureClass: "internal",
      exitCode: 1,
      effects: emptyComplete,
    });
    expect(run.result).toHaveProperty("handoff");
    expect(run.result).not.toHaveProperty("next");
    expect(run.ledger).toEqual(["handler-entered"]);
    // Twin (before entry): KF1.b sync-throw gives INTERNAL_PREPARATION.
    const twin = await runKf(entry, "read", ["read", "--json"], {
      KF_APPROVAL: "sync-throw",
    });
    expect(twin.result?.causeCode).toBe("INTERNAL_PREPARATION");
  },
  processWatchdog(2),
);
