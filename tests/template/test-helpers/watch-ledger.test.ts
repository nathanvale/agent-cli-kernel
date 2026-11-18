import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchLedger } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

test("watchLedger resolves once the ledger holds the line", async () => {
  const root = testFolder("watch-ledger-");
  const ledger = join(root, "ledger");
  const watch = watchLedger(ledger, "started", 10_000);
  try {
    writeFileSync(ledger, "begun\nstarted\n");
    expect(await watch.reached).toBeUndefined();
  } finally {
    watch.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchLedger rejects naming the ledger and the line once its bound passes", async () => {
  const root = testFolder("watch-ledger-");
  const ledger = join(root, "ledger");
  writeFileSync(ledger, "begun\nstarted later\n");
  const watch = watchLedger(ledger, "started", 50);
  try {
    const outcome = await watch.reached.then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    expect(outcome).toBe(
      `Error: ${ledger} did not hold the line "started" within 50 ms.`,
    );
  } finally {
    watch.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
