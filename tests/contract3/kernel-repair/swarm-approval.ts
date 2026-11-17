import { approval } from "../../../starters/contract3/src/addons/approval/index.ts";

export function approvalAddon(operation: string, note: (line: string) => void) {
  const store = process.env.GRANTS;
  return {
    attach(run: { readonly runId: string }) {
      const capability = store
        ? approval({
            operation,
            runId: run.runId,
            store: { grants: store, consumed: store },
          }).capability
        : {
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
