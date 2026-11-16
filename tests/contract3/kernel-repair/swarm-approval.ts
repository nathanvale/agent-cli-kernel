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
            check: () => {
              note("check");
              return Promise.resolve(process.env.CHECK === "true");
            },
          };
      return {
        capability,
        settle: () => Promise.resolve(true),
        killNow: () => undefined,
      };
    },
  };
}
