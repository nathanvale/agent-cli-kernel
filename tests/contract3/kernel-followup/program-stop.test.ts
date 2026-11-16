import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processWatchdog } from "../kernel-repair/swarm-process.ts";
import { tolerance } from "../lifecycle/oracle.ts";
import {
  emptyComplete,
  humanOneLine,
  materialiseKf,
  oneEnvelope,
  runKf,
} from "./harness.ts";

// Accepted decisions: contract question 5 of 8, its 16:23 follow-up
// (option C), the seven calls of 17:06 (form H, the name, the declaration
// rule N1b) and the four points of 17:24 (the station words N1d; the name
// is not enforced, N1e). An inspect command that runs programs and supports
// a deadline declares DOMAIN_<CLI>_DEADLINE_PROGRAM_STOP_UNCONFIRMED in its
// own station table; the kernel selects it when the deadline passed and an
// owned program was not confirmed stopped. Expected values come from
// expectations.md (KF3.b, KF3.f).
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

const programStop = "DOMAIN_KF_DEADLINE_PROGRAM_STOP_UNCONFIRMED";
// Independent oracle: the station words Nathan accepted at 17:24 (N1d).
const ruledHandoff = {
  owner: "operator",
  reason: "A program this command started may still be running.",
  inspect: [
    {
      kind: "instruction",
      text: "Look in the process table for a program this command started that is still running.",
    },
  ],
};
const ruledRepair =
  "Confirm that the program this command started has stopped before a new run.";
const deadlineArgv = ["watch", "--deadline-ms", "300"];

describe("KF3.b inspect-deadline-unconfirmed", () => {
  for (const settle of ["false", "throw"] as const)
    test(
      `KF3.b settle-${settle}: the kernel selects the declared program-stop station`,
      async () => {
        const run = await runKf(entry, "watch", [...deadlineArgv, "--json"], {
          KF_SETTLE: settle,
          KF_WAIT: "2000",
        });
        expect({ exit: run.exit, one: oneEnvelope(run) }).toEqual({
          exit: 3,
          one: true,
        });
        expect(run.result).toEqual({
          runId: run.result?.runId,
          commandIdentity: "kf.watch",
          outcome: "failed",
          effectClass: "inspect",
          transactionState: "unchanged",
          causeCode: programStop,
          failureClass: "domain",
          exitCode: 3,
          retryable: false,
          data: null,
          effects: emptyComplete,
          repairAction: ruledRepair,
          handoff: ruledHandoff,
        });
        expect(String(run.envelope?.message)).not.toBe("");
        expect(run.ledger).toContain("program-started");
        expect(run.firstByte).toBeLessThanOrEqual(300 + 500 + tolerance);
      },
      processWatchdog(1),
    );
  test(
    "KF3.b human: human mode prints one line on stderr and exits 3",
    async () => {
      const run = await runKf(entry, "watch", deadlineArgv, {
        KF_SETTLE: "false",
        KF_WAIT: "2000",
      });
      expect({ exit: run.exit, oneLine: humanOneLine(run) }).toEqual({
        exit: 3,
        oneLine: true,
      });
    },
    processWatchdog(1),
  );
  test(
    "KF3.b discovery lists the station; twin: a confirmed stop stays DOMAIN_DEADLINE_UNCHANGED",
    async () => {
      const discovered = await runKf(entry, "watch", [
        "--discover-command",
        "kf.watch",
        "--json",
      ]);
      expect(discovered.exit).toBe(0);
      // The published station for the program-stop cause, found by walking
      // the discovery data.
      const station = findStation(discovered.result?.data);
      expect(station).toMatchObject({
        causeCode: programStop,
        reachability: "required",
        retryDelayPolicy: { kind: "none" },
      });
      const twin = await runKf(entry, "watch", [...deadlineArgv, "--json"], {
        KF_SETTLE: "true",
        KF_WAIT: "2000",
      });
      expect(twin.exit).toBe(3);
      expect(twin.result).toMatchObject({
        causeCode: "DOMAIN_DEADLINE_UNCHANGED",
        outcome: "failed",
        transactionState: "unchanged",
      });
      expect(twin.result).toHaveProperty("next");
      expect(twin.result).not.toHaveProperty("handoff");
    },
    processWatchdog(2),
  );
});

function findStation(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStation(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (Reflect.get(value, "causeCode") === programStop) return value;
  return findStation(Object.values(value));
}
async function admission(variant: string) {
  const run = await runKf(entry, "watch-admission", [], {
    KF_WATCH_STATION: variant,
  });
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({
    exit: 0,
    stderr: "",
  });
  const value: unknown = JSON.parse(run.stdout);
  return value;
}
describe("KF3.f program-stop-station-required", () => {
  for (const variant of ["missing", "wrong-arm", "wrong-outcome"] as const)
    test(
      `KF3.f ${variant}: refused at declaration with a named refusal`,
      async () => {
        const result = await admission(variant);
        expect(result).toMatchObject({ admission: "refused" });
        expect(JSON.stringify(result)).toContain("kf.watch");
        expect(JSON.stringify(result)).toContain("program-stop station");
      },
      processWatchdog(1),
    );
  test(
    "KF3.f twins: the ruled station, another name, and commands without both programs and a deadline are admitted",
    async () => {
      for (const variant of [
        "ruled",
        "other-name",
        "no-deadline",
        "no-programs",
      ])
        expect({ variant, result: await admission(variant) }).toEqual({
          variant,
          result: { admission: "admitted" },
        });
      // A changing command with programs and deadline support needs no such
      // station: KF3.a's kf.apply runs (DOMAIN_DEADLINE_UNKNOWN).
    },
    processWatchdog(4),
  );
});
