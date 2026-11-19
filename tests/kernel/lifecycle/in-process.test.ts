import { afterEach, describe, expect, jest, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
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
import { rememberedRuns } from "../../../kernel/src/kernel/state-seam.ts";
import {
  recordRuntime,
  runtimeOf,
} from "../../../kernel/src/kernel/runtime.ts";
import { testFolder } from "../../support/test-folder.ts";
import { cancellationWait, stopBound } from "./oracle.ts";
import {
  advance,
  deferred,
  holdContract,
  recordingHost,
  shell,
  stateHoldContract,
  turns,
  until,
} from "./recording-host.ts";

const timeout = 30_000;
const addonSettleBudget = 300;
const stops = [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const;

type Holding = {
  readonly controls?: RunControl[];
  readonly kills?: string[];
  readonly emergencyRecord?: (facts: EmergencyFacts) => void;
  readonly onCrash?: (error: unknown) => void | Promise<void>;
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
    {
      addons,
      ...(options.emergencyRecord && {
        emergencyRecord: options.emergencyRecord,
      }),
      ...(options.onCrash && { onCrash: options.onCrash }),
    },
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
        await advance(addonSettleBudget - 1);
        expect(recorder.exits).toEqual([]);
        await advance(stopBound - addonSettleBudget + 1);
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

const reusedIdentity = {
  ok: false,
  path: "runId",
  reason: "run identity already attached",
} as const;
const nothingRemembered = { live: 0, attached: 0 } as const;
const oneRemembered = { live: 1, attached: 1 } as const;
const stateFolders: string[] = [];
afterEach(() => {
  for (const folder of stateFolders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function stateHolding(recorder: ReturnType<typeof recordingHost>) {
  const folder = testFolder("c3-run-identity-");
  stateFolders.push(folder);
  const queue: ReturnType<typeof held>[] = [];
  const controls: RunControl[] = [];
  const { contract, descriptor } = stateHoldContract(
    join(folder, "state"),
    async (programs) => {
      const gate = queue.shift();
      if (!gate) return;
      await programs.inspect(shell("exit 0"));
      gate.entered.resolve();
      await gate.returned.promise;
    },
  );
  const setup = { addons: { programs: watched({ controls }) } };
  const entry = runInProcessOn(contract, setup, () => recorder.host);
  return {
    contract,
    descriptor,
    setup,
    run: (argv: readonly string[] = ["change", "--json"]) => entry(argv),
    start(argv: readonly string[] = ["change", "--json"]) {
      const gate = held();
      queue.push(gate);
      return { gate, done: entry(argv) };
    },
    liveRunId() {
      const [control] = controls;
      if (!control) throw new Error("No run attached the programs add-on.");
      return control.runId;
    },
    reuse(runId: string) {
      const signal = new AbortController().signal;
      const programs = programsAddon().attach({
        runId,
        commandIdentity: "rc.change",
        summary: "Reuse a run identity.",
        signal,
      }).capability;
      return contract.execute("rc.change", [], runId, { programs, signal });
    },
  };
}

function causeOf(value: InProcessResult): string {
  if (value.kind !== "envelope")
    throw new Error(`Expected an envelope, got ${value.kind}.`);
  return value.envelope.result.causeCode;
}

describe("IP08 the state seam forgets a run identity when its run finishes", () => {
  test(
    "IP08.memory-returns-to-start many runs in sequence leave the state seam's memory at its starting size",
    async () => {
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      expect(rememberedRuns(subject.descriptor)).toEqual(nothingRemembered);
      const one = subject.start();
      await one.gate.entered.promise;
      expect(rememberedRuns(subject.descriptor)).toEqual(oneRemembered);
      one.gate.returned.resolve();
      const results = [await one.done];
      for (let index = 0; index < 20; index++)
        results.push(await subject.run());
      expect(results.map(causeOf)).toEqual(
        Array.from({ length: 21 }, () => "DOMAIN_RC_DECLINED"),
      );
      expect(new Set(results.map(runIdOf)).size).toBe(21);
      expect(rememberedRuns(subject.descriptor)).toEqual(nothingRemembered);
      expect(recorder.exits).toEqual([]);
    },
    timeout,
  );

  test(
    "IP08.reuse-after-finish-admitted an identity whose run finished attaches again",
    async () => {
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      const finished = await subject.run();
      expect(causeOf(finished)).toBe("DOMAIN_RC_DECLINED");
      const reused = await subject.reuse(finished.runId);
      expect(reused.ok).toBe(true);
      expect(rememberedRuns(subject.descriptor)).toEqual(oneRemembered);
    },
    timeout,
  );

  test(
    "IP08.reuse-while-live-refused an identity whose run is still live is refused, then attaches once the run finishes",
    async () => {
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      const one = subject.start();
      await one.gate.entered.promise;
      const runId = subject.liveRunId();
      expect(await subject.reuse(runId)).toEqual(reusedIdentity);
      expect(await subject.reuse(runId)).toEqual(reusedIdentity);
      one.gate.returned.resolve();
      expect((await one.done).runId).toBe(runId);
      expect(rememberedRuns(subject.descriptor)).toEqual(nothingRemembered);
      expect((await subject.reuse(runId)).ok).toBe(true);
    },
    timeout,
  );

  test(
    "IP08.live-past-deadline a run whose handler outlives its deadline keeps its identity until the handler returns",
    async () => {
      jest.useFakeTimers();
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      const one = subject.start(["change", "--deadline-ms", "1000", "--json"]);
      try {
        await one.gate.entered.promise;
        const runId = subject.liveRunId();
        await advance(1000 + cancellationWait);
        const returned = await one.done;
        expect(returned.runId).toBe(runId);
        expect(causeOf(returned)).toBe("DOMAIN_DEADLINE_UNCHANGED");
        expect(rememberedRuns(subject.descriptor)).toEqual(oneRemembered);
        expect(await subject.reuse(runId)).toEqual(reusedIdentity);
        one.gate.returned.resolve();
        await turns();
        expect(rememberedRuns(subject.descriptor)).toEqual(nothingRemembered);
        expect((await subject.reuse(runId)).ok).toBe(true);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP08.process-entry-keeps-identity runProcess still writes one envelope and keeps its run identity",
    async () => {
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      const code = await runProcessOn(
        subject.contract,
        subject.setup,
        () => recorder.host,
      )(["change", "--json"]);
      await turns();
      expect(code).toBe(3);
      expect(recorder.exits).toEqual([3]);
      expect(recorder.writes.map((write) => write.stream)).toEqual(["stdout"]);
      const written: unknown = JSON.parse(recorder.writes[0]?.text ?? "null");
      const checked = await runtimeOf(subject.contract)?.validate(written);
      if (!checked?.ok) throw new Error("runProcess wrote no valid envelope.");
      const runId = checked.value.result.runId;
      expect(rememberedRuns(subject.descriptor)).toEqual(oneRemembered);
      expect(await subject.reuse(runId)).toEqual(reusedIdentity);
    },
    timeout,
  );
});

const crashWaitBound = 450;

function listening() {
  const calls: unknown[][] = [];
  const settle = deferred();
  return {
    calls,
    settle,
    onCrash: (...args: unknown[]) => {
      calls.push(args);
      return settle.promise;
    },
  };
}

describe("IP09 a crash listener hears the error before the process exits", () => {
  test(
    "IP09.listener-after-records the listener hears the error after programs are stopped and records written, and exit follows its settle",
    async () => {
      jest.useFakeTimers();
      try {
        const recorder = recordingHost();
        const steps: string[] = [];
        const controls: RunControl[] = [];
        const listener = listening();
        const subject = holding(recorder, {
          controls,
          kills: steps,
          emergencyRecord: (fact) => steps.push(`record ${fact.runId}`),
          onCrash: (error) => {
            steps.push("listener");
            return listener.onCrash(error);
          },
        });
        const one = subject.start();
        await one.gate.entered.promise;
        const runId = controls[0]?.runId;
        if (runId === undefined) throw new Error("No run attached programs.");
        const error = new Error("Planted crash with a run in flight.");
        recorder.crash(error);
        expect(steps).toEqual([runId, `record ${runId}`, "listener"]);
        expect(listener.calls).toHaveLength(1);
        expect(listener.calls[0]?.[0]).toBe(error);
        await turns();
        expect(recorder.exits).toEqual([]);
        listener.settle.resolve();
        await turns();
        expect(recorder.exits).toEqual([1]);
        expect(recorder.writes).toEqual([]);
        one.gate.returned.resolve();
        await one.done;
      } finally {
        jest.useRealTimers();
      }
    },
    timeout,
  );

  test(
    "IP09.listener-bound a listener that never settles meets exit 450 ms after the crash",
    async () => {
      jest.useFakeTimers();
      try {
        const recorder = recordingHost();
        const listener = listening();
        const subject = holding(recorder, { onCrash: listener.onCrash });
        await subject.run(["hold", "--json"]);
        recorder.crash();
        await advance(crashWaitBound - 1);
        expect(recorder.exits).toEqual([]);
        await advance(1);
        expect(recorder.exits).toEqual([1]);
        expect(listener.calls).toHaveLength(1);
        expect(recorder.writes).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    },
    timeout,
  );

  const failing = [
    [
      "throws",
      () => {
        throw new Error("The listener threw.");
      },
    ],
    ["rejects", () => Promise.reject(new Error("The listener rejected."))],
  ] as const;
  for (const [name, onCrash] of failing)
    test(
      `IP09.listener-fails a listener that ${name} still meets exit 1 at once`,
      async () => {
        jest.useFakeTimers();
        try {
          const recorder = recordingHost();
          const facts: EmergencyFacts[] = [];
          const subject = holding(recorder, {
            onCrash,
            emergencyRecord: (fact) => facts.push(fact),
          });
          const one = subject.start();
          await one.gate.entered.promise;
          recorder.crash();
          await turns();
          expect(recorder.exits).toEqual([1]);
          expect(facts).toHaveLength(1);
          expect(recorder.writes).toEqual([]);
          one.gate.returned.resolve();
          await one.done;
        } finally {
          jest.useRealTimers();
        }
      },
      timeout,
    );

  test(
    "IP09.second-crash-exits-at-once a second crash during the wait exits at once and calls no listener again",
    async () => {
      jest.useFakeTimers();
      try {
        const recorder = recordingHost();
        const facts: EmergencyFacts[] = [];
        const listener = listening();
        const subject = holding(recorder, {
          onCrash: listener.onCrash,
          emergencyRecord: (fact) => facts.push(fact),
        });
        const one = subject.start();
        await one.gate.entered.promise;
        recorder.crash();
        await turns();
        expect(recorder.exits).toEqual([]);
        recorder.crash();
        expect(recorder.exits).toEqual([1]);
        await advance(crashWaitBound);
        expect(recorder.exits).toEqual([1]);
        expect(listener.calls).toHaveLength(1);
        expect(facts).toHaveLength(1);
        one.gate.returned.resolve();
        await one.done;
      } finally {
        jest.useRealTimers();
      }
    },
    timeout,
  );

  test(
    "IP09.no-listener-unchanged with no listener a crash still exits 1 at once",
    async () => {
      const recorder = recordingHost();
      const facts: EmergencyFacts[] = [];
      const subject = holding(recorder, {
        emergencyRecord: (fact) => facts.push(fact),
      });
      const one = subject.start();
      await one.gate.entered.promise;
      recorder.crash();
      expect(recorder.exits).toEqual([1]);
      expect(facts).toHaveLength(1);
      expect(recorder.writes).toEqual([]);
      one.gate.returned.resolve();
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.each-entry-listener two entries on one host each have their listener called once",
    async () => {
      jest.useFakeTimers();
      try {
        const recorder = recordingHost();
        const first = listening();
        const second = listening();
        await holding(recorder, { onCrash: first.onCrash }).run(["hold"]);
        await holding(recorder, { onCrash: second.onCrash }).run(["hold"]);
        const error = new Error("Planted crash after two entries ran.");
        recorder.crash(error);
        expect(first.calls).toEqual([[error]]);
        expect(second.calls).toEqual([[error]]);
        first.settle.resolve();
        await turns();
        expect(recorder.exits).toEqual([]);
        second.settle.resolve();
        await turns();
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
      }
    },
    timeout,
  );
});
