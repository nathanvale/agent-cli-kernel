import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { emptyComplete, materialiseKf, oneEnvelope, runKf } from "./harness.ts";

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
        expect(run.ledger).toContain("late-call");
        expect(run.ledger).toContain("transaction-refused");
        expect(applied(run.ledger, "kf.e")).toBe(0);
      }
    },
    processWatchdog(3),
  );
  test(
    "KF9.a D=520: the process ends before a transaction called after the lifecycle stopped waiting",
    async () => {
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
        expect(run.ledger).not.toContain("late-call");
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
