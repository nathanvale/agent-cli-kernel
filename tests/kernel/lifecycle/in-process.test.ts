import { describe, expect, jest, test } from "bun:test";
import { programsAddon } from "../../../kernel/src/addons/programs/index.ts";
import type {
  EmergencyFacts,
  InProcessResult,
  ProgramsCapability,
  RunAddon,
  RunControl,
} from "../../../kernel/src/kernel/index.ts";
import {
  runInProcessOn,
  runProcessOn,
} from "../../../kernel/src/kernel/lifecycle.ts";
import type { ProcessHost } from "../../../kernel/src/kernel/process-types.ts";
import {
  recordRuntime,
  runtimeOf,
} from "../../../kernel/src/kernel/runtime.ts";
import {
  exactStopBound,
  cancellationWait,
  stopBound,
  stopSettleLimit,
  stops,
} from "./oracle.ts";
import {
  aborted,
  advance,
  deferred,
  holdContract,
  recordingHost,
  shell,
  turns,
  until,
} from "./recording-host.ts";

const timeout = 30_000;

type Holding = {
  readonly controls?: RunControl[];
  readonly kills?: string[];
  readonly emergencyRecord?: (facts: EmergencyFacts) => void;
  readonly stopSettleHangs?: true;
  readonly host?: ProcessHost;
};

function watched(options: Holding): RunAddon<ProgramsCapability> {
  const inner = programsAddon();
  return {
    attach(run) {
      options.controls?.push(run);
      const innerAttached = inner.attach(run);
      const attached = {
        ...innerAttached,
        killNow: () => {
          options.kills?.push(run.runId);
          innerAttached.killNow();
        },
      };
      if (options.stopSettleHangs !== true) return attached;
      return {
        ...attached,
        settle: (limit) =>
          run.signal.aborted && limit !== undefined
            ? new Promise<boolean>(() => undefined)
            : attached.settle(limit),
      };
    },
  };
}

function held() {
  const entered = deferred();
  const returned = deferred();
  return { entered, returned };
}

function holding(
  recorder: ReturnType<typeof recordingHost>,
  options: Holding = {},
) {
  const queue: ReturnType<typeof held>[] = [];
  const entries: string[] = [];
  const addons = { programs: watched(options) };
  const host = options.host ?? recorder.host;
  const entry = runInProcessOn(
    holdContract(async (programs) => {
      const gate = queue.shift();
      entries.push("entered");
      await programs.inspect(shell("exit 0"));
      if (!gate) return;
      gate.entered.resolve();
      await gate.returned.promise;
    }),
    options.emergencyRecord
      ? { addons, emergencyRecord: options.emergencyRecord }
      : { addons },
    () => host,
  );
  return {
    entries,
    start(argv: readonly string[] = ["hold", "--json"]) {
      const gate = held();
      queue.push(gate);
      return { gate, done: entry(argv) };
    },
    run: (argv: readonly string[]) => entry(argv),
  };
}

function runIdOf(value: InProcessResult): string {
  return value.runId;
}

describe("IP01 the in-process entry returns each run's result", () => {
  test(
    "IP01.no-exit-after-run two runs in sequence each return their own envelope",
    async () => {
      const recorder = recordingHost();
      const controls: RunControl[] = [];
      const subject = holding(recorder, { controls });
      const first = await subject.run(["hold", "--json"]);
      const second = await subject.run(["hold"]);
      await turns();
      expect(recorder.exits).toEqual([]);
      expect(recorder.writes).toEqual([]);
      for (const value of [first, second]) {
        if (value.kind !== "envelope")
          throw new Error(`Expected an envelope, got ${value.kind}.`);
        expect(value.exitCode).toBe(0);
        expect(value.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
        expect(value.envelope.result.runId).toBe(value.runId);
      }
      expect(first.runId).not.toBe(second.runId);
      expect(controls.map((control) => control.runId)).toEqual([
        first.runId,
        second.runId,
      ]);
    },
    timeout,
  );

  test(
    "IP01.hooks-installed-once the signal and crash hooks install at the first run only",
    async () => {
      const recorder = recordingHost();
      const subject = holding(recorder);
      await subject.run(["hold", "--json"]);
      await subject.run(["hold", "--json"]);
      await subject.run(["hold", "--json"]);
      expect(recorder.installs).toEqual({ signal: 1, crash: 1 });
    },
    timeout,
  );

  test(
    "IP01.no-envelope a run whose result and fallback both fail validation returns no envelope",
    async () => {
      const recorder = recordingHost();
      const contract = holdContract(() => Promise.resolve());
      const runtime = runtimeOf(contract);
      if (!runtime) throw new Error("holdContract built no runtime.");
      const refusing = { cli: "rc" };
      recordRuntime(refusing, {
        ...runtime,
        validate: () =>
          Promise.resolve({
            ok: false,
            path: "$",
            reason: "The test validator refuses every envelope.",
          } as const),
      });
      const setup = { addons: { programs: programsAddon() } };
      const control = await runInProcessOn(
        contract,
        setup,
        () => recorder.host,
      )(["hold", "--json"]);
      expect(control.kind).toBe("envelope");
      const value = await runInProcessOn(
        refusing,
        setup,
        () => recorder.host,
      )(["hold", "--json"]);
      expect(value.kind).toBe("no-envelope");
      if (value.kind !== "no-envelope") return;
      expect(value.exitCode).toBe(1);
      expect(value.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(value.runId).not.toBe(control.runId);
      expect(recorder.writes).toEqual([]);
      expect(recorder.exits).toEqual([]);
    },
    timeout,
  );

  test(
    "IP01.process-entry-unchanged runProcess still writes one envelope and requests its exit",
    async () => {
      const recorder = recordingHost();
      const code = await runProcessOn(
        holdContract(() => Promise.resolve()),
        { addons: { programs: programsAddon() } },
        () => recorder.host,
      )(["hold", "--json"]);
      await turns();
      expect(code).toBe(0);
      expect(recorder.exits).toEqual([0]);
      expect(recorder.writes.map((write) => write.stream)).toEqual(["stdout"]);
      expect(recorder.writes[0]?.text.endsWith("}\n")).toBe(true);
    },
    timeout,
  );
});

describe("IP02 a stop signal reaches every run in flight", () => {
  for (const [signal, code] of stops)
    test(
      `IP02.stop-reaches-every-run ${signal}`,
      async () => {
        const recorder = recordingHost();
        const controls: RunControl[] = [];
        const subject = holding(recorder, { controls });
        const one = subject.start();
        const two = subject.start();
        await Promise.all([one.gate.entered.promise, two.gate.entered.promise]);
        expect(controls).toHaveLength(2);
        expect(controls.map((control) => control.signal.aborted)).toEqual([
          false,
          false,
        ]);
        recorder.signal(signal);
        expect(controls.map((control) => control.signal.aborted)).toEqual([
          true,
          true,
        ]);
        one.gate.returned.resolve();
        two.gate.returned.resolve();
        const results = await Promise.all([one.done, two.done]);
        expect(results.map((value) => value.kind)).toEqual([
          "stopped",
          "stopped",
        ]);
        expect(results.map(runIdOf).sort()).toEqual(
          controls.map((control) => control.runId).sort(),
        );
        expect(new Set(results.map(runIdOf)).size).toBe(2);
        for (const value of results)
          if (value.kind === "stopped") expect(value.signal).toBe(signal);
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        const late = await subject.run(["hold", "--json"]);
        expect(late.kind).toBe("stopped");
        expect(subject.entries).toHaveLength(2);
        expect(recorder.exits).toEqual([code]);
        expect(recorder.writes).toEqual([]);
      },
      timeout,
    );

  test(
    "IP02.repeated-stop-exits-at-once a second signal ends the process before the settle bound",
    async () => {
      const recorder = recordingHost();
      const subject = holding(recorder);
      const one = subject.start();
      await one.gate.entered.promise;
      recorder.signal("SIGTERM");
      expect(recorder.exits).toEqual([]);
      recorder.signal("SIGINT");
      expect(recorder.exits).toEqual([130]);
      one.gate.returned.resolve();
      await one.done;
    },
    timeout,
  );

  test(
    "IP02.repeated-stop-kills-settling-run a run that returned while its first-stop settle is pending is still killed at the second signal",
    async () => {
      const recorder = recordingHost();
      const controls: RunControl[] = [];
      const kills: string[] = [];
      const subject = holding(recorder, {
        controls,
        kills,
        stopSettleHangs: true,
      });
      const one = subject.start();
      await one.gate.entered.promise;
      recorder.signal("SIGTERM");
      one.gate.returned.resolve();
      const returned = await one.done;
      expect(returned.kind).toBe("stopped");
      expect(recorder.exits).toEqual([]);
      expect(kills).toEqual([]);
      recorder.signal("SIGTERM");
      expect(recorder.exits).toEqual([143]);
      expect(kills).toEqual(controls.map((control) => control.runId));
      expect(kills).toHaveLength(1);
    },
    timeout,
  );
});

describe("IP03 a crash records at most once for each run in flight", () => {
  test(
    "IP03.crash-records-run-in-flight one record for the run in flight, none for the finished run",
    async () => {
      const recorder = recordingHost();
      const facts: EmergencyFacts[] = [];
      const subject = holding(recorder, {
        emergencyRecord: (fact) => facts.push(fact),
      });
      const finished = await subject.run(["hold", "--json"]);
      const one = subject.start();
      const two = subject.start();
      await Promise.all([one.gate.entered.promise, two.gate.entered.promise]);
      recorder.crash();
      recorder.crash();
      expect(recorder.exits).toEqual([1, 1]);
      expect(facts.map((fact) => fact.phase)).toEqual([
        "handler-entered",
        "handler-entered",
      ]);
      expect(facts.map((fact) => fact.commandIdentity)).toEqual([
        "rc.hold",
        "rc.hold",
      ]);
      const recorded = facts.map((fact) => fact.runId);
      expect(new Set(recorded).size).toBe(2);
      expect(recorded).not.toContain(finished.runId);
      one.gate.returned.resolve();
      two.gate.returned.resolve();
      const results = await Promise.all([one.done, two.done]);
      expect([...recorded].sort()).toEqual(results.map(runIdOf).sort());
    },
    timeout,
  );
});

describe("IP07 the in-process entry checks its contract and bounds", () => {
  test("IP07.contract-refused a contract that contractFor did not build is refused", () => {
    const recorder = recordingHost();
    expect(() =>
      runInProcessOn({ cli: "rc" }, {}, () => recorder.host),
    ).toThrow("runInProcess needs a contract built by contractFor.");
    expect(() => runProcessOn({ cli: "rc" }, {}, () => recorder.host)).toThrow(
      "runProcess needs a contract built by contractFor.",
    );
  });

  test(
    "IP07.stop-bound exit comes at the stop bound when a run in flight never settles",
    async () => {
      const recorder = recordingHost();
      const subject = holding(recorder, { stopSettleHangs: true });
      const one = subject.start();
      await one.gate.entered.promise;
      jest.useFakeTimers();
      try {
        recorder.signal("SIGTERM");
        await advance(stopSettleLimit - 1);
        expect(recorder.exits).toEqual([]);
        await advance(stopBound - stopSettleLimit + 1);
        expect(recorder.exits).toEqual([143]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP07.own-deadline each run's deadline counts from its own start",
    async () => {
      jest.useFakeTimers();
      const recorder = recordingHost();
      const gates = [held(), held()];
      let entered = 0;
      const entry = runInProcessOn(
        holdContract(async () => {
          const gate = gates[entered];
          entered += 1;
          gate?.entered.resolve();
          await gate?.returned.promise;
        }),
        { addons: { programs: programsAddon() } },
        () => recorder.host,
      );
      const argv = ["hold", "--deadline-ms", "1000", "--json"];
      const settled: string[] = [];
      try {
        const first = entry(argv).then((value) => {
          settled.push("first");
          return value;
        });
        await gates[0]?.entered.promise;
        await advance(600);
        const second = entry(argv).then((value) => {
          settled.push("second");
          return value;
        });
        await gates[1]?.entered.promise;
        await advance(400 + cancellationWait);
        expect(settled).toEqual(["first"]);
        await advance(600 - 1);
        expect(settled).toEqual(["first"]);
        await advance(1);
        expect(settled).toEqual(["first", "second"]);
        for (const value of await Promise.all([first, second])) {
          if (value.kind !== "envelope")
            throw new Error(`Expected an envelope, got ${value.kind}.`);
          expect(value.envelope.result.causeCode).toBe(
            "DOMAIN_DEADLINE_UNCHANGED",
          );
        }
        expect(recorder.exits).toEqual([]);
      } finally {
        jest.useRealTimers();
        for (const gate of gates) gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP07.rejected-run-records-itself a run that rejects attempts its own emergency record and rejects to the caller",
    async () => {
      const recorder = recordingHost();
      let clockFails = false;
      const host: ProcessHost = {
        ...recorder.host,
        now() {
          if (clockFails) throw new Error("The test clock failed.");
          return performance.now();
        },
      };
      const controls: RunControl[] = [];
      const facts: EmergencyFacts[] = [];
      const subject = holding(recorder, {
        controls,
        host,
        emergencyRecord: (fact) => facts.push(fact),
      });
      const one = subject.start(["hold", "--deadline-ms", "60000", "--json"]);
      await one.gate.entered.promise;
      clockFails = true;
      one.gate.returned.resolve();
      const failure = await one.done.then(
        () => "returned",
        (error: unknown) =>
          error instanceof Error ? error.message : "not an Error",
      );
      expect(failure).toBe("The test clock failed.");
      expect(controls.map((control) => control.signal.aborted)).toEqual([true]);
      expect(facts.map((fact) => fact.runId)).toEqual(
        controls.map((control) => control.runId),
      );
      expect(facts).toHaveLength(1);
      expect(recorder.exits).toEqual([]);
    },
    timeout,
  );
});

function waitingForStop(
  recorder: ReturnType<typeof recordingHost>,
  onEntry: () => void = () => undefined,
) {
  const queue: ReturnType<typeof held>[] = [];
  const entry = runInProcessOn(
    holdContract(async (_programs, signal) => {
      const gate = queue.shift();
      if (!gate) return;
      onEntry();
      gate.entered.resolve();
      await aborted(signal);
      await gate.returned.promise;
    }),
    { addons: { programs: programsAddon() } },
    () => recorder.host,
  );
  return {
    async start() {
      const gate = held();
      queue.push(gate);
      const done = entry(["hold", "--json"]);
      await gate.entered.promise;
      return { gate, done };
    },
  };
}

async function exitedOnce(
  recorder: ReturnType<typeof recordingHost>,
): Promise<boolean> {
  return (await until(() => recorder.exits.length > 0)) && true;
}

describe("IP10 a stop request waits for every run's handler inside the stop bound", () => {
  for (const [signal, code] of stops)
    for (const cleanUp of [0, 200, exactStopBound - 1])
      test(
        `IP10.waits-for-handler a stop request on ${signal} waits through a ${String(cleanUp)} ms handler clean-up, then exits ${String(code)} with nothing written`,
        async () => {
          jest.useFakeTimers();
          const recorder = recordingHost();
          const one = await waitingForStop(recorder).start();
          try {
            const sentAt = recorder.stopAt(signal);
            await turns();
            if (cleanUp > 0) await advance(cleanUp);
            expect(recorder.exits).toEqual([]);
            one.gate.returned.resolve();
            expect(await exitedOnce(recorder)).toBe(true);
            expect(recorder.exits).toEqual([code]);
            expect(recorder.exitedAt.map((at) => at - sentAt)).toEqual([
              cleanUp,
            ]);
            expect(recorder.writes).toEqual([]);
            expect((await one.done).kind).toBe("stopped");
          } finally {
            jest.useRealTimers();
            one.gate.returned.resolve();
          }
        },
        timeout,
      );

  for (const last of ["second", "first"] as const)
    test(
      `IP10.waits-for-every-run a stop request waits until the last run's handler returns, when the ${last} run returns last`,
      async () => {
        jest.useFakeTimers();
        const recorder = recordingHost();
        const subject = waitingForStop(recorder);
        const one = await subject.start();
        const two = await subject.start();
        const [early, late] = last === "second" ? [one, two] : [two, one];
        try {
          const sentAt = recorder.stopAt("SIGTERM");
          await advance(100);
          early.gate.returned.resolve();
          await turns();
          expect(recorder.exits).toEqual([]);
          await advance(200);
          late.gate.returned.resolve();
          expect(await exitedOnce(recorder)).toBe(true);
          expect(recorder.exits).toEqual([143]);
          expect(recorder.exitedAt.map((at) => at - sentAt)).toEqual([300]);
        } finally {
          jest.useRealTimers();
          one.gate.returned.resolve();
          two.gate.returned.resolve();
        }
      },
      timeout,
    );

  test(
    "IP10.waits-for-add-on a stop request waits for an add-on that settles after the handler returns, up to the stop bound",
    async () => {
      const recorder = recordingHost();
      const subject = holding(recorder, { stopSettleHangs: true });
      const one = subject.start();
      await one.gate.entered.promise;
      jest.useFakeTimers();
      try {
        const sentAt = recorder.stopAt("SIGTERM");
        await advance(100);
        one.gate.returned.resolve();
        await turns();
        expect(recorder.exits).toEqual([]);
        await advance(exactStopBound - 100 - 1);
        expect(recorder.exits).toEqual([]);
        await advance(1);
        expect(recorder.exits).toEqual([143]);
        expect(recorder.exitedAt.map((at) => at - sentAt)).toEqual([
          exactStopBound,
        ]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP10.stop-during-entry a stop request delivered during handler entry, before its first await, waits through its clean-up",
    async () => {
      jest.useFakeTimers();
      const recorder = recordingHost();
      const sent: number[] = [];
      const one = await waitingForStop(recorder, () => {
        sent.push(recorder.stopAt("SIGTERM"));
      }).start();
      try {
        await turns();
        await advance(200);
        expect(recorder.exits).toEqual([]);
        one.gate.returned.resolve();
        expect(await exitedOnce(recorder)).toBe(true);
        expect(recorder.exits).toEqual([143]);
        expect(recorder.exitedAt.map((at) => at - (sent[0] ?? 0))).toEqual([
          200,
        ]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP10.handler-never-ends a handler that never returns is cut off at the stop bound",
    async () => {
      jest.useFakeTimers();
      const recorder = recordingHost();
      const one = await waitingForStop(recorder).start();
      try {
        const sentAt = recorder.stopAt("SIGINT");
        await advance(exactStopBound - 1);
        expect(recorder.exits).toEqual([]);
        await advance(1);
        expect(recorder.exits).toEqual([130]);
        expect(recorder.exitedAt.map((at) => at - sentAt)).toEqual([
          exactStopBound,
        ]);
        expect(recorder.writes).toEqual([]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );
});
