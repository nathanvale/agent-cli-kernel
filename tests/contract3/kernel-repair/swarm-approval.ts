// One owner for the approval add-on the swarm-triage process cases install.
// With GRANTS set it is the shipped approval add-on over that (empty) store;
// otherwise a test-owned add-on that records each check and answers CHECK.
// Copied unchanged into the materialised fixture tree.
import { approval } from "../../../starters/contract3/src/addons/approval/index.ts";

export function approvalAddon(operation: string, note: (line: string) => void) {
  const store = process.env.GRANTS;
  return {
    attach(run: { readonly runId: string }) {
      const capability = store
        ? approval({
            operation,
            runId: run.runId,
            store: { grants: store, ledger: store },
          }).capability
        : {
            // CHECK_DELAY delays the answer and ledgers `check-start` as a
            // signal barrier; CHECK=throw is a grant-store fault (K3-spec-1,
            // K3-spec-2).
            check: async () => {
              const delay = Number(process.env.CHECK_DELAY ?? "0");
              if (delay > 0) {
                note("check-start");
                await Bun.sleep(delay);
              }
              if (process.env.CHECK === "throw")
                throw new Error("Grant store unavailable.");
              note("check");
              return process.env.CHECK === "true";
            },
          };
      const settleDelay = Number(process.env.SETTLE_DELAY ?? "0");
      return {
        capability,
        settle: () => Bun.sleep(settleDelay).then(() => true),
        killNow: () => undefined,
      };
    },
  };
}
