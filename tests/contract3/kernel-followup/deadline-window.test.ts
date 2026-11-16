import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { emptyComplete, materialiseKf, oneEnvelope, runKf } from "./harness.ts";

// The step-2 builder's Left item 2 (K2-spec-3): from the deadline on, the
// run's state capability starts no transaction and records no effect.
// LIFE-6, WIRE-12, WIRE-15; accepted decision N9 (17:06): with no
// transaction started before the deadline, DOMAIN_DEADLINE_UNCHANGED with
// the declared effects remaining. Expected values come from expectations.md
// (KF9).
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

const deadline = 300;
// Independent oracle: WIRE-18's N words for DOMAIN_DEADLINE_UNCHANGED, as
// the base supplies them (accepted wording).
const deadlineNext = {
  kind: "instruction",
  text: "Inspect the deadline and the input, then explicitly decide whether to start a new run.",
};
const applied = (ledger: readonly string[], effect: string) =>
  ledger.filter((line) => line === `effect-applied ${effect}`).length;
function late(mode: string, wait: number) {
  return runKf(
    entry,
    "late",
    ["apply", "--deadline-ms", String(deadline), "--json"],
    { KF_LATE: mode, KF_LATE_MS: String(wait) },
  );
}

describe("KF9.a transaction-after-deadline-refused", () => {
  test(
    "KF9.a D=100: a transaction called inside the 500 ms wait is refused before its work",
    async () => {
      for (let round = 0; round < 3; round++) {
        const run = await late("transaction", deadline + 100);
        expect({ round, exit: run.exit, one: oneEnvelope(run) }).toEqual({
          round,
          exit: 3,
          one: true,
        });
        expect(run.result).toMatchObject({
          causeCode: "DOMAIN_DEADLINE_UNCHANGED",
          outcome: "failed",
          transactionState: "unchanged",
          failureClass: "domain",
          retryable: false,
          effects: { ...emptyComplete, remaining: ["kf.e"] },
          next: deadlineNext,
        });
        expect(run.result).not.toHaveProperty("handoff");
        expect(run.ledger).toContain("transaction-refused");
        expect(applied(run.ledger, "kf.e")).toBe(0);
      }
    },
    processWatchdog(3),
  );
  test(
    "KF9.a D=520: a transaction called after the lifecycle stopped waiting never applies",
    async () => {
      // Observed: the kernel emits and exits about 800 ms after start, before
      // the late call at about 820 ms, so these rounds prove only that no
      // effect applies beside the envelope. The expectation's ledger line
      // `transaction-refused` cannot appear here; a pending stdout reader
      // cannot hold the process, because the envelope fits the pipe buffer.
      for (let round = 0; round < 3; round++) {
        const run = await late("transaction", deadline + 520);
        expect({ round, exit: run.exit, one: oneEnvelope(run) }).toEqual({
          round,
          exit: 3,
          one: true,
        });
        expect(run.result).toMatchObject({
          causeCode: "DOMAIN_DEADLINE_UNCHANGED",
          effects: { ...emptyComplete, remaining: ["kf.e"] },
        });
        expect(applied(run.ledger, "kf.e")).toBe(0);
      }
    },
    processWatchdog(3),
  );
  test(
    "KF9.a twin: a transaction completed before the deadline is the trusted summary",
    async () => {
      const run = await late("early", 0);
      expect(run.exit).toBe(3);
      expect(run.result).toMatchObject({
        causeCode: "DOMAIN_DEADLINE_COMPLETED",
        transactionState: "completed",
        effects: { ...emptyComplete, completed: ["kf.e"] },
      });
      expect(run.result).toHaveProperty("handoff");
      expect(applied(run.ledger, "kf.e")).toBe(1);
    },
    processWatchdog(1),
  );
});

describe("KF9.b effect-after-deadline-refused", () => {
  test(
    "KF9.b an effect recorded after the deadline is refused before its operation",
    async () => {
      const run = await late("effect", deadline + 100);
      expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
        exit: 3,
        one: true,
      });
      expect(run.result?.outcome).toBe("failed");
      expect(applied(run.ledger, "kf.e1")).toBe(1);
      expect(applied(run.ledger, "kf.e2")).toBe(0);
      expect(run.ledger).toContain("transaction-refused");
      const effects = run.result?.effects;
      expect(JSON.stringify(effects)).not.toContain("kf.e2");
      // Twin: both effects recorded before the deadline.
      const twin = await late("both", 0);
      expect(twin.exit).toBe(3);
      expect(twin.result).toMatchObject({
        causeCode: "DOMAIN_DEADLINE_COMPLETED",
        effects: { ...emptyComplete, completed: ["kf.e1", "kf.e2"] },
      });
    },
    processWatchdog(2),
  );
});
