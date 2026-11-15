// S7: the production default composition, run as a process with no fault
// wrappers: runProcess(contractFor(...)) with the default process adapter.
// Expectations come from the frozen oracle rows.
import { describe, expect, test } from "bun:test";
import {
  canaryCli,
  cleanup,
  envelopeOf,
  exitWithin,
  expectedRow,
  goneWithin,
  launch,
  release,
  resultOf,
} from "./harness.ts";

const timeout = 30_000;
const tolerance = 100;

describe("public-seam canary (supporting S7, not a frozen case)", () => {
  for (const [id, route, identity, causeCode] of [
    ["canary.success", "read", "canary.read", "SUCCESS_UNCHANGED"],
    ["canary.refusal", "refuse", "canary.refuse", "DOMAIN_PRECONDITION_UNMET"],
  ] as const)
    test(
      id,
      async () => {
        const observed = await (
          await launch({ argv: [route, "--json"], script: canaryCli })
        ).done;
        try {
          const row = expectedRow(causeCode);
          const result = resultOf(envelopeOf(observed.stdout));
          expect(observed.stderr.byteLength).toBe(0);
          expect(observed.signal).toBeNull();
          expect(observed.code).toBe(row.exitCode);
          expect(result).toMatchObject({
            commandIdentity: identity,
            causeCode,
            outcome: row.outcome,
            exitCode: row.exitCode,
          });
        } finally {
          await cleanup(observed);
        }
      },
      timeout,
    );

  test(
    "canary.signal",
    async () => {
      const launched = await launch({
        argv: ["wait", "--json"],
        script: canaryCli,
      });
      try {
        await launched.barrier("child-started");
        const sent = launched.signal("SIGINT");
        const observed = await exitWithin(launched);
        expect(observed.signal).toBeNull();
        expect(observed.code).toBe(130);
        expect(observed.stdout.byteLength).toBe(0);
        expect(observed.stderr.byteLength).toBe(0);
        expect(observed.exitedAt - sent).toBeLessThanOrEqual(500 + tolerance);
        const line = observed.ledger.find((entry) =>
          entry.startsWith("child-started "),
        );
        const child = Number(line?.split(" ")[1]);
        if (!Number.isSafeInteger(child) || child <= 0)
          throw new Error("No owned child pid.");
        expect(await goneWithin(child, 300)).toBe(true);
      } finally {
        await release(launched);
      }
    },
    timeout,
  );
});
