// Platform: Bun 1.4.4 fake timers clamp a raw delay above 2,147,483,647 ms to
// 1 ms while still advancing performance.now().
import { afterEach, describe, expect, jest, test } from "bun:test";
import { programsAddon } from "../../../kernel/src/addons/programs/index.ts";
import type {
  ProgramsCapability,
  RunAddon,
} from "../../../kernel/src/kernel/index.ts";
import { runProcessOn } from "../../../kernel/src/kernel/lifecycle.ts";
import type { StopSignal } from "../../../kernel/src/kernel/process-types.ts";
import {
  aborted,
  advance,
  deferred,
  holdContract,
  recordingHost,
  shell,
  turns,
} from "./recording-host.ts";
import {
  cancellationWait,
  exactStopBound,
  overLimitBoundary,
  stopSettleLimit,
  stops,
  timerLimit,
} from "./oracle.ts";

afterEach(() => {
  jest.useRealTimers();
});

async function heldUntilDeadline(
  deadline: number,
  work?: (signal: AbortSignal, startedAt: number) => Promise<void>,
) {
  jest.useFakeTimers();
  const entered = deferred();
  const returned = deferred();
  const recorder = recordingHost();
  const startedAt = performance.now();
  const done = runProcessOn(
    holdContract(async (_programs, signal) => {
      entered.resolve();
      await (work ? work(signal, startedAt) : returned.promise);
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
        expect(run.recorder.writes).toEqual([]);
        expect(run.recorder.exits).toEqual([]);
        await advance(1 + cancellationWait);
        const [write] = run.recorder.writes;
        expect(run.recorder.writes.length).toBe(1);
        expect(write?.stream).toBe("stdout");
        expect(causeOf(write?.text ?? "null")).toBe(
          "DOMAIN_DEADLINE_UNCHANGED",
        );
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

describe("the handler's abort signal at a deadline", () => {
  for (const cleanUp of [0, 200])
    test(`a handler waiting on its abort signal is awaited through a ${String(cleanUp)} ms clean-up, and the result is written when it returns`, async () => {
      const deadline = 300;
      const cleaned = deferred();
      const seen: string[] = [];
      const run = await heldUntilDeadline(
        deadline,
        async (signal, startedAt) => {
          seen.push(`entered aborted=${String(signal.aborted)}`);
          await aborted(signal);
          seen.push(`aborted at=${String(performance.now() - startedAt)}`);
          await cleaned.promise;
          seen.push(`cleaned at=${String(performance.now() - startedAt)}`);
        },
      );
      try {
        await advance(deadline - 1);
        expect(seen).toEqual(["entered aborted=false"]);
        await advance(1);
        if (cleanUp > 0) await advance(cleanUp);
        expect(seen).toEqual([
          "entered aborted=false",
          `aborted at=${String(deadline)}`,
        ]);
        expect(run.recorder.writes).toEqual([]);
        cleaned.resolve();
        await turns();
        expect(seen[2]).toBe(`cleaned at=${String(deadline + cleanUp)}`);
        const [write] = run.recorder.writes;
        expect(run.recorder.writes.length).toBe(1);
        expect(causeOf(write?.text ?? "null")).toBe(
          "DOMAIN_DEADLINE_UNCHANGED",
        );
        expect((write?.at ?? 0) - run.startedAt).toBe(deadline + cleanUp);
        expect(run.recorder.exits).toEqual([3]);
      } finally {
        cleaned.resolve();
        await advance(cancellationWait);
        await run.finish();
      }
    });
});

function slowSettlingPrograms(): RunAddon<ProgramsCapability> {
  const inner = programsAddon();
  return {
    attach(run) {
      const attached = inner.attach(run);
      return {
        ...attached,
        capability: {
          ...attached.capability,
          inspect: () =>
            Promise.reject(new Error("The test add-on starts no program.")),
        },
        settle: (limit) =>
          limit === undefined
            ? Promise.resolve(false)
            : new Promise<boolean>((resolve) => {
                setTimeout(() => {
                  resolve(false);
                }, limit);
              }),
      };
    },
  };
}

function attachOnFirstUse(programs: ProgramsCapability): Promise<unknown> {
  return programs.inspect(shell("exit 0")).catch(() => undefined);
}

async function heldUntilStop(
  work: (
    signal: AbortSignal,
    released: Promise<void>,
    programs: ProgramsCapability,
    stop: (signal: StopSignal) => number,
  ) => Promise<void>,
  programs: RunAddon<ProgramsCapability> = programsAddon(),
) {
  jest.useFakeTimers();
  const entered = deferred();
  const released = deferred();
  const recorder = recordingHost();
  const stop = (signal: StopSignal): number => recorder.stopAt(signal);
  const done = runProcessOn(
    holdContract(async (capability, signal) => {
      entered.resolve();
      await work(signal, released.promise, capability, stop);
    }),
    { addons: { programs } },
    () => recorder.host,
  )(["hold", "--json"]);
  await entered.promise;
  await turns();
  return {
    recorder,
    async release() {
      released.resolve();
      await turns();
    },
    stop,
    async expectExitAt(sentAt: number, after: number, code: number) {
      await advance(sentAt + after - 1 - performance.now());
      expect(recorder.exits).toEqual([]);
      await advance(1);
      expect(recorder.exits).toEqual([code]);
      expect(recorder.exitedAt.map((at) => at - sentAt)).toEqual([after]);
      expect(recorder.writes).toEqual([]);
    },
    async finish() {
      released.resolve();
      await advance(exactStopBound);
      jest.useRealTimers();
      await done;
    },
  };
}

describe("a stop request waits for the handler inside the stop bound", () => {
  for (const [signal, code] of stops)
    for (const cleanUp of [0, 200, exactStopBound - 1])
      test(`a stop request on ${signal} waits through a ${String(cleanUp)} ms handler clean-up, then exits ${String(code)} with nothing written`, async () => {
        const seen: string[] = [];
        const run = await heldUntilStop(async (abortSignal, released) => {
          await aborted(abortSignal);
          seen.push("aborted");
          await released;
          seen.push("cleaned");
        });
        try {
          const sentAt = run.stop(signal);
          await turns();
          if (cleanUp > 0) await advance(cleanUp);
          expect(seen).toEqual(["aborted"]);
          expect(run.recorder.exits).toEqual([]);
          await run.release();
          expect(seen).toEqual(["aborted", "cleaned"]);
          expect(run.recorder.exits).toEqual([code]);
          expect(run.recorder.exitedAt.map((at) => at - sentAt)).toEqual([
            cleanUp,
          ]);
          expect(run.recorder.writes).toEqual([]);
        } finally {
          await run.finish();
        }
      });

  for (const [signal, code] of stops)
    test(`a handler that throws in its clean-up at 200 ms on ${signal} exits ${String(code)} at 200 ms with nothing written`, async () => {
      const run = await heldUntilStop(async (abortSignal, released) => {
        await aborted(abortSignal);
        await released;
        throw new Error("The handler's clean-up failed.");
      });
      try {
        const sentAt = run.stop(signal);
        await advance(200);
        expect(run.recorder.exits).toEqual([]);
        await run.release();
        expect(run.recorder.exits).toEqual([code]);
        expect(run.recorder.exitedAt.map((at) => at - sentAt)).toEqual([200]);
        expect(run.recorder.writes).toEqual([]);
      } finally {
        await run.finish();
      }
    });

  for (const [signal, code] of stops)
    test(`a handler that never ends is cut off at the ${String(exactStopBound)} ms stop bound on ${signal}, exiting ${String(code)}`, async () => {
      const run = await heldUntilStop((_signal, released) => released);
      try {
        const sentAt = run.stop(signal);
        await run.expectExitAt(sentAt, exactStopBound, code);
      } finally {
        await run.finish();
      }
    });

  for (const [signal, code] of stops)
    test(`a handler that never ends beside an add-on that settles at its ${String(stopSettleLimit)} ms limit exits ${String(code)} at the ${String(exactStopBound)} ms stop bound on ${signal}`, async () => {
      const run = await heldUntilStop(async (_signal, released, programs) => {
        await attachOnFirstUse(programs);
        await released;
      }, slowSettlingPrograms());
      try {
        const sentAt = run.stop(signal);
        await run.expectExitAt(sentAt, exactStopBound, code);
      } finally {
        await run.finish();
      }
    });

  for (const [first, second, code] of [
    ["SIGTERM", "SIGINT", 130],
    ["SIGINT", "SIGTERM", 143],
  ] as const)
    test(`a second stop request (${second} after ${first}) while the handler is awaited exits ${String(code)} at once`, async () => {
      const run = await heldUntilStop((_signal, released) => released);
      try {
        run.stop(first);
        await advance(200);
        expect(run.recorder.exits).toEqual([]);
        const againAt = run.stop(second);
        expect(run.recorder.exits).toEqual([code]);
        expect(run.recorder.exitedAt).toEqual([againAt]);
        expect(run.recorder.writes).toEqual([]);
      } finally {
        await run.finish();
      }
    });

  for (const [signal, code] of stops)
    test(`a stop request on ${signal} delivered during handler entry, before the handler's first await, waits through its 200 ms clean-up, then exits ${String(code)}`, async () => {
      const seen: string[] = [];
      let sentAt = Number.NaN;
      const run = await heldUntilStop(
        async (abortSignal, released, _programs, stop) => {
          sentAt = stop(signal);
          seen.push(`aborted=${String(abortSignal.aborted)}`);
          await released;
          seen.push("cleaned");
        },
      );
      try {
        await advance(200);
        expect(seen).toEqual(["aborted=true"]);
        expect(run.recorder.exits).toEqual([]);
        await run.release();
        expect(seen).toEqual(["aborted=true", "cleaned"]);
        expect(run.recorder.exits).toEqual([code]);
        expect(run.recorder.exitedAt.map((at) => at - sentAt)).toEqual([200]);
        expect(run.recorder.writes).toEqual([]);
      } finally {
        await run.finish();
      }
    });

  for (const [signal, code] of stops)
    test(`a handler that ends at 100 ms beside an add-on that settles at its ${String(stopSettleLimit)} ms limit exits ${String(code)} when the add-on settles, at ${String(stopSettleLimit)} ms, on ${signal}`, async () => {
      const run = await heldUntilStop(async (_signal, released, programs) => {
        await attachOnFirstUse(programs);
        await released;
      }, slowSettlingPrograms());
      try {
        const sentAt = run.stop(signal);
        await advance(100);
        await run.release();
        expect(run.recorder.exits).toEqual([]);
        await run.expectExitAt(sentAt, stopSettleLimit, code);
      } finally {
        await run.finish();
      }
    });
});

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
