import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { programsAddon } from "../../../kernel/src/addons/programs/index.ts";
import type {
  ProgramsCapability,
  RunAddon,
} from "../../../kernel/src/kernel/index.ts";
import { runProcessOn } from "../../../kernel/src/kernel/lifecycle.ts";
import { receipt } from "./checks.ts";
import { exitWithin, launch, readLedger, release } from "./harness.ts";
import { stopBound, supporting, tolerance } from "./oracle.ts";
import {
  deferred,
  holdContract,
  killMarked,
  markedPids,
  note,
  recordingHost,
  shell,
  turns,
} from "./recording-host.ts";

const timeout = 30_000;
const stops = [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const;

async function settles(done: Promise<number>): Promise<boolean> {
  return Promise.race([
    done.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
}

describe("S02 the main flow requests no exit after a stop (finding 2)", () => {
  for (const [signal, code] of stops)
    test(`S02.main-flow-requests-no-exit-after-stop ${signal}`, async () => {
      const entered = deferred();
      const returned = deferred();
      const recorder = recordingHost();
      const done = runProcessOn(
        holdContract(async () => {
          entered.resolve();
          await returned.promise;
        }),
        { addons: { programs: programsAddon() } },
        () => recorder.host,
      )(["hold", "--json"]);
      await entered.promise;
      recorder.signal(signal);
      returned.resolve();
      expect(await settles(done)).toBe(true);
      await turns();
      expect(recorder.exits).toEqual([code]);
      expect(recorder.writes).toEqual([]);
    });
});

function settleRecorder(
  calls: (number | null)[],
): RunAddon<ProgramsCapability> {
  const inner = programsAddon();
  return {
    attach(run) {
      const attached = inner.attach(run);
      return {
        ...attached,
        settle(limit) {
          calls.push(limit ?? null);
          return attached.settle(limit);
        },
      };
    },
  };
}

type LateShape = "first-attach" | "after-finished-program";

async function lateRequest(shape: LateShape, signal: "SIGTERM" | "SIGINT") {
  const dir = await mkdtemp(join(tmpdir(), "kernel-s04-"));
  const ledger = join(dir, "ledger");
  const marker = `FX-S04-MARKER-${crypto.randomUUID()}`;
  const entered = deferred();
  const returned = deferred();
  const settleCalls: (number | null)[] = [];
  let outcome = "not-called";
  const recorder = recordingHost();
  try {
    const done = runProcessOn(
      holdContract(async (programs) => {
        if (shape === "after-finished-program")
          await programs.inspect(shell("exit 0"));
        entered.resolve();
        await returned.promise;
        try {
          await programs.inspect(
            shell(`: ${marker}; echo late-child >> '${ledger}'; /bin/sleep 30`),
          );
          outcome = "started";
        } catch {
          outcome = "refused";
        }
      }),
      { addons: { programs: settleRecorder(settleCalls) } },
      () => recorder.host,
    )(["hold", "--json"]);
    await entered.promise;
    recorder.signal(signal);
    returned.resolve();
    const settled = await settles(done);
    await turns();
    await Bun.sleep(200);
    return {
      settled,
      outcome,
      settleCalls,
      exits: recorder.exits,
      writes: recorder.writes,
      childLedgered: existsSync(ledger)
        ? (await readFile(ledger, "utf8")).includes("late-child")
        : false,
      markedProcesses: markedPids(marker).length,
    };
  } finally {
    try {
      killMarked(marker);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

describe("S04 no owned resource after a stop: component (finding 2)", () => {
  for (const shape of ["first-attach", "after-finished-program"] as const)
    for (const [signal, code] of stops)
      test(
        `S04.no-owned-resource-after-stop component ${shape} ${signal}`,
        async () => {
          const seen = await lateRequest(shape, signal);
          note({
            id: "S03.post-handler-settle-after-stop",
            shape,
            signal,
            settleLimits: seen.settleCalls,
          });
          expect(seen.settled).toBe(true);
          expect(seen.outcome).toBe("refused");
          expect(seen.childLedgered).toBe(false);
          expect(seen.markedProcesses).toBe(0);
          expect(seen.exits).toEqual([code]);
          expect(seen.writes).toEqual([]);
        },
        timeout,
      );
});

describe("S04 no owned resource after a stop: real host (finding 2)", () => {
  test(
    "S04.no-owned-resource-after-stop process second inspect while the stop path settles",
    async () => {
      const entry = supporting("S04.no-owned-resource-after-stop", {
        argv: ["late-start", "--json"],
      });
      const before = markedPids("FX-LATE-MARKER").length;
      const launched = await launch({ argv: entry.argv });
      try {
        await launched.barrier("handler-ready");
        const sent = launched.signal("SIGTERM");
        const observed = await exitWithin(launched);
        receipt(entry, observed, {
          signalToExitMilliseconds: observed.exitedAt - sent,
        });
        expect(observed.signal).toBeNull();
        expect(observed.code).toBe(143);
        expect(observed.stdout.byteLength).toBe(0);
        expect(observed.stderr.byteLength).toBe(0);
        expect(observed.exitedAt - sent).toBeLessThanOrEqual(
          stopBound + tolerance,
        );
        expect(observed.ledger).toContain("late-call");
        expect(observed.ledger).toContain("late-refused");
        expect(
          readLedger(launched.ledgerPath).some((line) =>
            line.startsWith("late-child"),
          ),
        ).toBe(false);
        expect(markedPids("FX-LATE-MARKER").length).toBe(before);
      } finally {
        await release(launched);
      }
    },
    timeout,
  );
});
