import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    expect(shifting.result).toMatchObject({
      commandIdentity: "specimen.apply",
      outcome: "failed",
    });
    expect(String(shifting.result?.causeCode)).toStartWith("INTERNAL_RESULT_");
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
    expect(await printed("run-reuse", { SECOND_RUN_ID: "R" })).toEqual({
      first: completed,
      second: { executed: false },
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
              child.result?.outcome === "refused" &&
              child.result.transactionState === "unchanged",
            ledger: lines,
          });
        }
      expect(observed).toHaveLength(12);
      // Every run entered the handler and printed one envelope.
      for (const entry of observed)
        expect(entry.ledger).toContain("handler-returned");
      // No run printed refused-unchanged beside an applied effect.
      expect(
        observed.filter(
          (entry) =>
            entry.refusedUnchanged && entry.ledger.includes("effect-applied"),
        ),
      ).toEqual([]);
    } finally {
      await rm(ledgers, { recursive: true, force: true });
    }
  },
  processTimeout,
);
