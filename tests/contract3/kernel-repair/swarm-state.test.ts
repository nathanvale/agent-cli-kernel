import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialise } from "./harness.ts";
import { processWatchdog, runScenario } from "./swarm-process.ts";
import type { SignalAt } from "./swarm-process.ts";

// Swarm-triage expectations that need a state installation (X-K1-4,
// X-K1-10, X-K2S1, X-K2S2, X-K2S3). The installation is a test-only fixture
// in a materialised addons/state folder; each case runs the materialised
// CLI entry as a real child process. Expected values come from the triage
// file's expectations, written from the frozen contract.
// Each test here runs at most six child processes; X-K2S3 runs twelve.
const processTimeout = processWatchdog(6);
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
  signalAt?: SignalAt,
) {
  return runScenario(
    scenario,
    argv,
    env,
    join(root, "tests/contract3/kernel-repair/swarm-state-cli.ts"),
    signalAt,
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

test(
  "X-K1-10.coordination-causes-host-owned: a common cause is refused as a held-lock or unresolved-case cause",
  async () => {
    // CMD-10: a distinct unresolved-case refusal with a host-owned cause.
    // CMD-12: the held-lock refusal is owned by that CLI; the state add-on
    // adds no common cause. WIRE-19: a domain-specific cause is command-owned.
    const refused = {
      admission: "refused",
      reason: "Coordination refusal causes are host-owned.",
    };
    expect(await printed("coordination-lock-common")).toEqual(refused);
    expect(await printed("coordination-unresolved-common")).toEqual(refused);
    // Twin: the host causes HELD and PRIOR are admitted.
    expect(await printed("coordination-host")).toEqual({
      admission: "admitted",
    });
  },
  processTimeout,
);

test(
  "X-K2S1.proof-single-read: a proof is built from the one observation read it was validated on",
  async () => {
    // WIRE-12: `unchanged` means completed is empty, a confirmed no-change;
    // CMD-10a: a handler cannot assert a transaction state. An observation
    // that reads `completed` then `unchanged` must not yield a proof that
    // lets the HELD refusal print with empty effects.
    const shifting = await run("proof-accessor", ["apply", "--json"]);
    expect({ exit: shifting.exit, stderr: shifting.stderr }).toEqual({
      exit: 1,
      stderr: "",
    });
    // The issuer issues its proof from the one read (completed, "e"), and
    // that proof is the trusted summary (contract question 4 of 8).
    expect(shifting.result).toMatchObject({
      commandIdentity: "specimen.apply",
      outcome: "failed",
      causeCode: "INTERNAL_RESULT_COMPLETED",
      transactionState: "completed",
      effects: {
        completed: ["e"],
        remaining: [],
        uncertain: [],
        inventoryComplete: true,
      },
    });
    // Twin: a steady unchanged observation admits the HELD refusal.
    const steady = await run("proof-steady", ["apply", "--json"]);
    expect(steady.exit).toBe(3);
    expect(steady.result).toMatchObject({
      commandIdentity: "specimen.apply",
      causeCode: "HELD",
      outcome: "refused",
      transactionState: "unchanged",
    });
  },
  processTimeout,
);

test(
  "X-K2S2.run-identity-reuse: a second execution under a run identity that holds a completed proof builds no refusal",
  async () => {
    // WIRE-7: runId is a unique invocation identity; WIRE-12: `unchanged`
    // is a confirmed no-change. Run R completes "e" under a proof, so no
    // envelope for R may then claim refused and unchanged.
    const completed = {
      executed: true,
      runId: "R",
      causeCode: "SUCCESS_COMPLETED",
      transactionState: "completed",
      completed: ["e"],
    };
    // The reuse is refused for its own reason (path runId), every time.
    const reused = { executed: false, path: "runId" };
    expect(await printed("run-reuse", { SECOND_RUN_ID: "R" })).toEqual({
      first: completed,
      second: reused,
      third: reused,
    });
    // Twin: a fresh run identity builds the HELD refusal normally.
    expect(await printed("run-reuse", { SECOND_RUN_ID: "R2" })).toEqual({
      first: completed,
      second: {
        executed: true,
        runId: "R2",
        causeCode: "HELD",
        transactionState: "unchanged",
        completed: [],
      },
      third: { executed: false, path: "runId" },
    });
  },
  processTimeout,
);

test(
  "X-K2S3.closed-after-result: no effect is applied after a refusal that said unchanged",
  async () => {
    // WIRE-15: a refusal precedes any attempted change; WIRE-12: unchanged is
    // a confirmed no-change. The handler queues a transaction behind N
    // microtask hops and returns HELD at once; the transaction's work writes
    // `effect-applied` to an independent ledger the parent reads after exit.
    const ledgers = await mkdtemp(join(tmpdir(), "contract3-swarm-ledger-"));
    try {
      // The hop counts are the triage's observed window (triage K2-spec-3):
      // at 0 and 5 hops the transaction starts before the result is built,
      // so the build refuses and the honest fallback prints; from 24 hops
      // the process exits first. 8 to 20 is where the refusal printed beside
      // an applied effect. Three rounds each, as X-K2S3 asks.
      const observed: {
        hops: number;
        refusedUnchanged: boolean;
        ledger: string[];
      }[] = [];
      for (const hops of [8, 12, 16, 20])
        for (let round = 0; round < 3; round++) {
          const ledger = join(ledgers, `${hops}-${round}.txt`);
          const child = await run("late-transaction", ["apply", "--json"], {
            HOPS: String(hops),
            LEDGER: ledger,
          });
          expect(child.stderr).toBe("");
          const lines = (await readFile(ledger, "utf8").catch(() => ""))
            .split("\n")
            .filter((line) => line !== "");
          observed.push({
            hops,
            refusedUnchanged:
              child.result?.causeCode === "HELD" &&
              child.result.outcome === "refused" &&
              child.result.transactionState === "unchanged",
            ledger: lines,
          });
        }
      // Per run (S4): the refusal printed, the late transaction was
      // attempted and refused before its work, and no effect was applied.
      expect(observed).toEqual(
        [8, 12, 16, 20].flatMap((hops) =>
          [0, 1, 2].map(() => ({
            hops,
            refusedUnchanged: true,
            ledger: [
              "handler-returned",
              "transaction-refused: The state capability closed when the handler returned.",
            ],
          })),
        ),
      );
    } finally {
      await rm(ledgers, { recursive: true, force: true });
    }
  },
  processWatchdog(12),
);

test(
  "X-S6.state-not-attached-on-denial: an approval denial attaches no state and enters no handler",
  async () => {
    // CMD-9: step 5's non-consuming preflight precedes step 6, which
    // attaches the declared capabilities and enters the handler.
    const ledgers = await mkdtemp(join(tmpdir(), "contract3-swarm-attach-"));
    try {
      const attempt = async (name: string, env: Record<string, string>) => {
        const ledger = join(ledgers, `${name}.txt`);
        const child = await run("approval-attach", ["guarded", "--json"], {
          ...env,
          LEDGER: ledger,
        });
        const lines = (await readFile(ledger, "utf8").catch(() => ""))
          .split("\n")
          .filter((line) => line !== "");
        return { child, lines };
      };
      // The shipped approval add-on over an empty grant store (an existing,
      // empty directory; delta F7) denies.
      const store = join(ledgers, "store");
      await mkdir(store);
      const denied = await attempt("denied", { GRANTS: store });
      expect({ exit: denied.child.exit, stderr: denied.child.stderr }).toEqual({
        exit: 3,
        stderr: "",
      });
      expect(denied.child.result).toMatchObject({
        commandIdentity: "specimen.guarded",
        outcome: "refused",
        transactionState: "unchanged",
        causeCode: "DOMAIN_AUTHORITY_REQUIRED",
      });
      expect(denied.lines).toEqual([]);
      // Twin: an accepting check attaches state, then enters the handler.
      const admitted = await attempt("admitted", { CHECK: "true" });
      expect(admitted.child.exit).toBe(3);
      expect(admitted.child.result).toMatchObject({ causeCode: "HELD" });
      expect(admitted.lines).toEqual([
        "check",
        "state-attached",
        "handler-entered",
      ]);
    } finally {
      await rm(ledgers, { recursive: true, force: true });
    }
  },
  processTimeout,
);

test(
  "B1.ifnoresult-global-switch: an ifNoResult step carrying a global switch is refused at declaration",
  async () => {
    // DISC-13: the recovery step is a command step (STEP-6) checked when
    // declared, so the fallback can always be produced (DISC-11b, LIFE-9);
    // INPUT-3: a switch value would route the step to navigation.
    for (const value of [
      "--help",
      "--discover",
      "--discover-command",
      "--json",
    ])
      expect(
        await printed("ifnoresult-title-admission", { VALUE: value }),
      ).toEqual({
        admission: "refused",
        reason: `ifNoResult step specimen.pending ${JSON.stringify(["--title", value])} carries a global switch before --.`,
      });
    // Twin: a plain value is admitted and the fallback prints with the step.
    expect(
      await printed("ifnoresult-title-admission", { VALUE: "plain" }),
    ).toEqual({ admission: "admitted" });
    const twin = await run("ifnoresult-title", ["apply", "--json"], {
      VALUE: "plain",
    });
    expect({ exit: twin.exit, stderr: twin.stderr }).toEqual({
      exit: 1,
      stderr: "",
    });
    expect(twin.result).toMatchObject({
      commandIdentity: "specimen.apply",
      causeCode: "INTERNAL_RESULT_UNKNOWN",
      handoff: {
        inspect: [
          {
            kind: "command",
            command: "specimen.pending",
            args: ["--title", "plain"],
          },
        ],
      },
    });
  },
  processTimeout,
);

test(
  "F1.unguarded-raw-changing-refused: a changing declaration without the two-phase entry is refused",
  async () => {
    // CMD-9: state attaches only at step 6, after the preflight; a spread
    // changing declaration has no registered entry (delta review F1).
    expect(await printed("spread-changing-admission")).toEqual({
      admission: "refused",
      reason:
        "A command that declares approval or changes state must be built with command() or changing().",
    });
    // Twin: the same command, not spread, is admitted (X-K1-10's host twin
    // composes it the same way).
    expect(await printed("coordination-host")).toEqual({
      admission: "admitted",
    });
  },
  processTimeout,
);

test(
  "F2.check-phase-claims-nothing: a denied run leaves its run identity unclaimed",
  async () => {
    // CMD-9: steps 3 to 5 attach and claim nothing; the run identity is
    // claimed with the state attachment at step 6 (delta review F2).
    const ledger = join(root, "f2-ledger.txt");
    expect(await printed("deny-then-grant", { LEDGER: ledger })).toEqual({
      denied: "approval",
      granted: "entered",
    });
  },
  processTimeout,
);

// K3-spec-1 and K3-spec-2: the approval check phase runs before handler
// entry. Each run gets a fresh ledger, read 1 s after exit so a late handler
// would have written to it.
async function preflightRun(
  name: string,
  argv: readonly string[],
  env: Record<string, string>,
  signal?: "SIGTERM",
) {
  const ledger = join(root, `preflight-${name}.txt`);
  const child = await run(
    "approval-attach",
    ["guarded", ...argv],
    { ...env, LEDGER: ledger },
    signal ? { ledger, line: "check-start", signal } : undefined,
  );
  await Bun.sleep(1000);
  const lines = (await readFile(ledger, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line !== "");
  return { child, lines };
}
// The lifecycle row "Deadline before operation dispatch" (read: before
// handler entry, Nathan 16 November 2026) and WIRE-15.
const beforeStart = {
  commandIdentity: "specimen.guarded",
  outcome: "refused",
  transactionState: "unchanged",
  causeCode: "DOMAIN_DEADLINE_BEFORE_START",
  exitCode: 3,
  effects: {
    completed: [],
    remaining: [],
    uncertain: [],
    inventoryComplete: true,
  },
};

test(
  "X-S1a and X-S2a.deadline-during-check-phase: a deadline during the approval check refuses before handler entry",
  async () => {
    // LIFE-6: at the deadline the command stops starting work; CMD-9 step 6
    // follows steps 4 and 5. Checks delayed 200 ms and 1,000 ms.
    for (const delay of ["200", "1000"]) {
      const observed = await preflightRun(
        `deadline-${delay}`,
        ["--deadline-ms", "50", "--json"],
        { CHECK: "true", CHECK_DELAY: delay },
      );
      expect({
        exit: observed.child.exit,
        stderr: observed.child.stderr,
      }).toEqual({
        exit: 3,
        stderr: "",
      });
      expect(observed.child.stdout.trim().split("\n")).toHaveLength(1);
      expect(observed.child.result).toMatchObject(beforeStart);
      expect(observed.lines).not.toContain("handler-entered");
      expect(observed.lines).not.toContain("state-attached");
    }
  },
  processWatchdog(2),
);

test(
  "X-S1b.stop-during-check-phase: SIGTERM during the approval check exits 143 with no handler entry",
  async () => {
    // LIFE-3: stop new domain work at the first stop request; LIFE-4.
    const observed = await preflightRun(
      "sigterm",
      ["--json"],
      { CHECK: "true", CHECK_DELAY: "200", SETTLE_DELAY: "400" },
      "SIGTERM",
    );
    expect({
      exit: observed.child.exit,
      stdout: observed.child.stdout,
      stderr: observed.child.stderr,
    }).toEqual({ exit: 143, stdout: "", stderr: "" });
    expect(observed.lines).toEqual(["check-start", "check"]);
  },
  processWatchdog(1),
);

test(
  "X-S2b.check-phase-store-fault: a fault in the approval check is a preparation refusal before handler entry",
  async () => {
    // LIFE-9 step 1 "Before dispatch" (before handler entry):
    // INTERNAL_PREPARATION, refused and unchanged; WIRE-15.
    const observed = await preflightRun("fault", ["--json"], {
      CHECK: "throw",
      CHECK_DELAY: "1",
    });
    expect({
      exit: observed.child.exit,
      stderr: observed.child.stderr,
    }).toEqual({
      exit: 1,
      stderr: "",
    });
    expect(observed.child.stdout.trim().split("\n")).toHaveLength(1);
    expect(observed.child.result).toMatchObject({
      commandIdentity: "specimen.guarded",
      outcome: "refused",
      transactionState: "unchanged",
      causeCode: "INTERNAL_PREPARATION",
    });
    expect(observed.lines).toEqual(["check-start"]);
  },
  processWatchdog(1),
);
