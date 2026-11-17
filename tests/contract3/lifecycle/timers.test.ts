// Finding 1, kernel side: the deadline timer honours every accepted value
// (Nathan, 16 November 2026: no cap). Expectations: c3-expect-t2t5,
// findings-round/expectations.md, T02(b) and T06.
//
// Time control (P4, proposed for review): Bun 1.4.4's fake timers clamp a raw
// delay above 2,147,483,647 ms to 1 ms exactly like real timers, so they cannot
// hold such a delay. They do advance performance.now(), which the kernel's
// clock reads, so a timer that arms at most the limit and re-reads the clock
// can be driven past the limit here with no production seam.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { programsAddon } from "../../../starters/contract3/src/addons/programs/index.ts";
import { runProcessOn } from "../../../starters/contract3/src/kernel/lifecycle.ts";
import {
  advance,
  deferred,
  holdContract,
  recordingHost,
  turns,
} from "./recording-host.ts";
import { overLimitBoundary, timerLimit } from "./oracle.ts";

// LIFE-6: at the deadline, wait at most 500 ms for cancellation.
const cancellationWait = 500;

afterEach(() => {
  jest.useRealTimers();
});

// A handler that never finishes by itself, under fake timers.
async function heldUntilDeadline(deadline: number) {
  jest.useFakeTimers();
  const entered = deferred();
  const returned = deferred();
  const recorder = recordingHost();
  const startedAt = performance.now();
  const done = runProcessOn(
    holdContract(async () => {
      entered.resolve();
      await returned.promise;
    }),
    { addons: { programs: programsAddon() } },
    () => recorder.host,
  )(["hold", "--deadline-ms", String(deadline), "--json"]);
  await entered.promise;
  await turns();
  return {
    recorder,
    startedAt,
    async finish() {
      returned.resolve();
      await turns();
      jest.useRealTimers();
      await done;
    },
  };
}

function causeOf(text: string): unknown {
  const envelope: unknown = JSON.parse(text);
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const result: unknown = Reflect.get(envelope, "result");
  return typeof result === "object" && result !== null
    ? Reflect.get(result, "causeCode")
    : undefined;
}

describe("T02(b) expiry after handler entry for a deadline above the timer limit (finding 1)", () => {
  for (const deadline of overLimitBoundary)
    test(`T02.deadline-above-limit-expiry-after-dispatch D=${deadline}`, async () => {
      const run = await heldUntilDeadline(deadline);
      try {
        await advance(deadline - 1);
        // One millisecond before the deadline: no deadline result yet.
        expect(run.recorder.writes).toEqual([]);
        expect(run.recorder.exits).toEqual([]);
        await advance(1 + cancellationWait);
        const [write] = run.recorder.writes;
        expect(run.recorder.writes.length).toBe(1);
        expect(write?.stream).toBe("stdout");
        expect(causeOf(write?.text ?? "null")).toBe(
          "DOMAIN_DEADLINE_UNCHANGED",
        );
        // Under fake time the result is written at exactly D + 500 ms.
        expect((write?.at ?? 0) - run.startedAt).toBe(
          deadline + cancellationWait,
        );
        expect(run.recorder.exits).toEqual([3]);
      } finally {
        await run.finish();
      }
    });
});

describe("T06 small and boundary deadlines keep their exact timing (finding 1)", () => {
  for (const deadline of [1, 300, timerLimit])
    test(`T06.small-values-unchanged deadline D=${deadline}`, async () => {
      const run = await heldUntilDeadline(deadline);
      try {
        // The deadline result is written exactly when the 500 ms wait ends:
        // nothing rounds the deadline up, adds a chunk or defers the arm.
        await advance(deadline + cancellationWait - 1);
        expect(run.recorder.writes).toEqual([]);
        await advance(1);
        expect(run.recorder.writes.length).toBe(1);
        expect((run.recorder.writes[0]?.at ?? 0) - run.startedAt).toBe(
          deadline + cancellationWait,
        );
      } finally {
        await run.finish();
      }
    });
});

// Contract review F3: P4 rests on two facts about Bun 1.4.4's fake timers. If
// a Bun upgrade changes either, this fails by name before any T02(b), T05 or
// T06 result is trusted.
test("P4.canary fake timers advance the clock and fire a raw over-limit delay early", () => {
  jest.useFakeTimers();
  const before = performance.now();
  let rawFired = false;
  const raw = setTimeout(() => {
    rawFired = true;
  }, timerLimit + 1);
  jest.advanceTimersByTime(5);
  clearTimeout(raw);
  expect(performance.now() - before).toBe(5);
  expect(rawFired).toBe(true);
});
