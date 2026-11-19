import { afterEach, describe, expect, jest, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { programsAddon } from "../../../kernel/src/addons/programs/index.ts";
import type {
  EmergencyFacts,
  StateCapability,
  InProcessResult,
  ProgramsCapability,
  RunAddon,
  RunControl,
} from "../../../kernel/src/kernel/index.ts";
import {
  runInProcessOn,
  runProcessOn,
} from "../../../kernel/src/kernel/lifecycle.ts";
import type {
  InProcessSetup,
  ProcessHost,
} from "../../../kernel/src/kernel/process-types.ts";
import type { StateAddonDescriptor } from "../../../kernel/src/kernel/state-seam.ts";
import {
  attachedRunCount,
  createStateAddon,
} from "../../../kernel/src/kernel/state-seam.ts";
import {
  recordRuntime,
  runtimeOf,
} from "../../../kernel/src/kernel/runtime.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  cancellationWait,
  exactStopBound,
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
  stateHoldContract,
  turns,
  until,
} from "./recording-host.ts";

const timeout = 30_000;
afterEach(() => {
  jest.useRealTimers();
});

type Holding = {
  readonly controls?: RunControl[];
  readonly kills?: string[];
  readonly onKill?: () => void;
  readonly emergencyRecord?: (facts: EmergencyFacts) => void;
  readonly onCrash?: InProcessSetup["onCrash"];
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
          options.onKill?.();
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
      await programs.inspect(shell("exit 0", { timeoutMilliseconds: 5_000 }));
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

const reusedIdentity = {
  ok: false,
  path: "runId",
  reason: "run identity already attached",
} as const;
const noRunAttached = 0;
const oneRunAttached = 1;
const sequentialRuns = 20;
const stateFolders: string[] = [];
afterEach(() => {
  for (const folder of stateFolders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function stateHolding(
  recorder: ReturnType<typeof recordingHost>,
  host: (descriptor: StateAddonDescriptor) => ProcessHost = () => recorder.host,
  emergencyRecord?: (facts: EmergencyFacts) => void,
) {
  const folder = testFolder("c3-run-identity-");
  stateFolders.push(folder);
  const queue: ReturnType<typeof held>[] = [];
  const controls: RunControl[] = [];
  const states: StateCapability<"rc.note">[] = [];
  const { contract, descriptor } = stateHoldContract(
    join(folder, "state"),
    async (programs, state) => {
      states.push(state);
      entered.count += 1;
      const gate = queue.shift();
      if (!gate) return;
      await programs.inspect(shell("exit 0", { timeoutMilliseconds: 5_000 }));
      gate.entered.resolve();
      await gate.returned.promise;
    },
  );
  const setup = {
    addons: { programs: watched({ controls }) },
    ...(emergencyRecord && { emergencyRecord }),
  };
  const entered = { count: 0 };
  const entry = runInProcessOn(contract, setup, () => host(descriptor));
  return {
    contract,
    descriptor,
    setup,
    entered,
    states,
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

function asUuid(
  id: string,
): `${string}-${string}-${string}-${string}-${string}` {
  const [a, b, c, d, e, ...rest] = id.split("-");
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    rest.length > 0
  )
    throw new Error(`${id} is not a run identity.`);
  return `${a}-${b}-${c}-${d}-${e}`;
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
      expect(attachedRunCount(subject.descriptor)).toEqual(noRunAttached);
      const one = subject.start();
      await one.gate.entered.promise;
      expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
      one.gate.returned.resolve();
      const results = [await one.done];
      for (let index = 0; index < sequentialRuns; index++)
        results.push(await subject.run());
      expect(results.map(causeOf)).toEqual(
        Array.from({ length: sequentialRuns + 1 }, () => "DOMAIN_RC_DECLINED"),
      );
      expect(new Set(results.map(runIdOf)).size).toBe(sequentialRuns + 1);
      expect(attachedRunCount(subject.descriptor)).toEqual(noRunAttached);
      expect(recorder.exits).toEqual([]);
    },
    timeout,
  );

  test(
    "IP08.reuse-after-finish-attaches an identity whose run finished attaches again",
    async () => {
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      const finished = await subject.run();
      expect(causeOf(finished)).toBe("DOMAIN_RC_DECLINED");
      const reused = await subject.reuse(finished.runId);
      if (!reused.ok)
        throw new Error(`The reuse was refused: ${reused.reason}.`);
      const built = await subject.contract.buildResult(reused.value);
      expect(built).toMatchObject({
        ok: true,
        value: {
          result: { runId: finished.runId, causeCode: "DOMAIN_RC_DECLINED" },
        },
      });
      expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
    },
    timeout,
  );

  test(
    "IP08.reuse-while-live-refused an identity whose run is still live is refused on every attempt, then attaches once the run finishes",
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
      expect(attachedRunCount(subject.descriptor)).toEqual(noRunAttached);
      expect((await subject.reuse(runId)).ok).toBe(true);
    },
    timeout,
  );

  test(
    "IP08.attached-never-entered a run that attaches state but never enters its handler forgets its identity",
    async () => {
      const recorder = recordingHost();
      const jump = 120_000;
      const subject = stateHolding(recorder, (descriptor) => ({
        ...recorder.host,
        now: () =>
          performance.now() + (attachedRunCount(descriptor) > 0 ? jump : 0),
      }));
      const value = await subject.run([
        "change",
        "--deadline-ms",
        "60000",
        "--json",
      ]);
      expect(causeOf(value)).toBe("DOMAIN_DEADLINE_BEFORE_START");
      expect(subject.entered.count).toBe(0);
      expect(attachedRunCount(subject.descriptor)).toEqual(noRunAttached);
    },
    timeout,
  );

  test(
    "IP08.rejected-run-forgets a run that rejects forgets its identity",
    async () => {
      const recorder = recordingHost();
      const clock = { fails: false };
      const subject = stateHolding(recorder, () => ({
        ...recorder.host,
        now() {
          if (clock.fails) throw new Error("The test clock failed.");
          return performance.now();
        },
      }));
      const one = subject.start(["change", "--deadline-ms", "60000", "--json"]);
      await one.gate.entered.promise;
      expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
      clock.fails = true;
      one.gate.returned.resolve();
      const failure = await one.done.then(
        () => "returned",
        (error: unknown) =>
          error instanceof Error ? error.message : "not an Error",
      );
      expect(failure).toBe("The test clock failed.");
      expect(attachedRunCount(subject.descriptor)).toEqual(noRunAttached);
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
        expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
        expect(await subject.reuse(runId)).toEqual(reusedIdentity);
        one.gate.returned.resolve();
        expect(
          await until(
            () => attachedRunCount(subject.descriptor) === noRunAttached,
          ),
        ).toBe(true);
        expect((await subject.reuse(runId)).ok).toBe(true);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP08.reuse-keeps-live-run a refused reuse leaves the live run attached, so its deadline still closes it",
    async () => {
      jest.useFakeTimers();
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      const one = subject.start(["change", "--deadline-ms", "1000", "--json"]);
      try {
        await one.gate.entered.promise;
        const runId = subject.liveRunId();
        expect(await subject.reuse(runId)).toEqual(reusedIdentity);
        expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
        await advance(1000 + cancellationWait);
        const returned = await one.done;
        expect(returned.runId).toBe(runId);
        expect(causeOf(returned)).toBe("DOMAIN_DEADLINE_UNCHANGED");
        const [kept] = subject.states;
        if (!kept) throw new Error("The handler kept no state capability.");
        expect(
          await kept
            .transaction(() => Promise.resolve())
            .then(
              () => "opened",
              (error: unknown) =>
                error instanceof Error ? error.message : "not an Error",
            ),
        ).toBe("The state capability closed at the deadline.");
        one.gate.returned.resolve();
        expect(
          await until(
            () => attachedRunCount(subject.descriptor) === noRunAttached,
          ),
        ).toBe(true);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP08.duplicate-keeps-live-run a refused in-process duplicate leaves the live run attached, so its deadline still closes it",
    async () => {
      jest.useFakeTimers();
      const recorder = recordingHost();
      const subject = stateHolding(recorder);
      const one = subject.start(["change", "--deadline-ms", "1000", "--json"]);
      try {
        await one.gate.entered.promise;
        const runId = subject.liveRunId();
        const duplicate = jest
          .spyOn(crypto, "randomUUID")
          .mockReturnValueOnce(asUuid(runId));
        const refused = await subject.run(["change", "--json"]);
        duplicate.mockRestore();
        expect(refused.runId).toBe(runId);
        expect(causeOf(refused)).toBe("USAGE_INVALID_INVOCATION");
        expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
        await advance(1000 + cancellationWait);
        const returned = await one.done;
        expect(causeOf(returned)).toBe("DOMAIN_DEADLINE_UNCHANGED");
        expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
        const [kept] = subject.states;
        if (!kept) throw new Error("The handler kept no state capability.");
        expect(
          await kept
            .transaction(() => Promise.resolve())
            .then(
              () => "opened",
              (error: unknown) =>
                error instanceof Error ? error.message : "not an Error",
            ),
        ).toBe("The state capability closed at the deadline.");
        one.gate.returned.resolve();
        expect(
          await until(
            () => attachedRunCount(subject.descriptor) === noRunAttached,
          ),
        ).toBe(true);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP08.duplicate-then-crash a refused in-process duplicate leaves the live run attached when it crashes",
    async () => {
      const recorder = recordingHost();
      const facts: EmergencyFacts[] = [];
      const subject = stateHolding(
        recorder,
        () => recorder.host,
        (fact) => facts.push(fact),
      );
      const one = subject.start();
      try {
        await one.gate.entered.promise;
        const runId = subject.liveRunId();
        const duplicate = jest
          .spyOn(crypto, "randomUUID")
          .mockReturnValueOnce(asUuid(runId));
        const refused = await subject.run(["change", "--json"]);
        duplicate.mockRestore();
        expect(refused.runId).toBe(runId);
        expect(causeOf(refused)).toBe("USAGE_INVALID_INVOCATION");
        expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
        recorder.crash();
        expect(facts.map((fact) => fact.runId)).toEqual([runId]);
        expect(attachedRunCount(subject.descriptor)).toEqual(oneRunAttached);
        expect(recorder.exits).toEqual([1]);
        one.gate.returned.resolve();
        expect(runIdOf(await one.done)).toBe(runId);
        expect(attachedRunCount(subject.descriptor)).toEqual(noRunAttached);
      } finally {
        one.gate.returned.resolve();
      }
    },
    timeout,
  );

  test(
    "IP08.attach-throws-forgets a state add-on whose attach throws leaves no run attached",
    async () => {
      const recorder = recordingHost();
      const folder = testFolder("c3-run-identity-");
      stateFolders.push(folder);
      const descriptor = createStateAddon((issuer) => ({
        ifNoResult: issuer.ifNoResult({
          kind: "command",
          command: "rc.pending",
          args: [],
        }),
        attach() {
          throw new Error("The state add-on could not attach.");
        },
      }));
      const { contract } = stateHoldContract(
        join(folder, "state"),
        () => Promise.resolve(),
        descriptor,
      );
      const returned = await runInProcessOn(
        contract,
        { addons: { programs: watched({ controls: [] }) } },
        () => recorder.host,
      )(["change", "--json"]);
      expect(causeOf(returned)).toBe("INTERNAL_PREPARATION");
      expect(attachedRunCount(descriptor)).toEqual(noRunAttached);
    },
    timeout,
  );

  test(
    "IP08.process-entry-unchanged runProcess with a state command still writes one envelope and requests its exit",
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
      expect(checked.value.result.causeCode).toBe("DOMAIN_RC_DECLINED");
    },
    timeout,
  );
});

function recordedOnCrash() {
  const calls: unknown[][] = [];
  const settle = deferred();
  const called = deferred();
  return {
    calls,
    settle,
    called: called.promise,
    onCrash: (...args: unknown[]) => {
      calls.push(args);
      called.resolve();
      return settle.promise;
    },
  };
}

async function heldRun(subject: ReturnType<typeof holding>) {
  const one = subject.start();
  await one.gate.entered.promise;
  return one;
}

describe("IP09 onCrash hears the error before the process exits", () => {
  test(
    "IP09.listener-after-records onCrash hears the error after the kill attempt, the records and the abort, and exit follows its settle",
    async () => {
      const recorder = recordingHost();
      const steps: string[] = [];
      const controls: RunControl[] = [];
      const listener = recordedOnCrash();
      const subject = holding(recorder, {
        controls,
        kills: steps,
        emergencyRecord: (fact) => steps.push(`record ${fact.runId}`),
        onCrash: (error) => {
          steps.push(`listener aborted=${String(controls[0]?.signal.aborted)}`);
          return listener.onCrash(error);
        },
      });
      const one = await heldRun(subject);
      jest.useFakeTimers();
      try {
        const runId = controls[0]?.runId;
        if (runId === undefined) throw new Error("No run attached programs.");
        const error = new Error("Planted crash with a run in flight.");
        recorder.crash(error);
        await listener.called;
        expect(steps).toEqual([
          runId,
          `record ${runId}`,
          "listener aborted=true",
        ]);
        expect(listener.calls).toHaveLength(1);
        expect(listener.calls[0]?.[0]).toBe(error);
        await turns();
        expect(recorder.exits).toEqual([]);
        listener.settle.resolve();
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        expect(recorder.exits).toEqual([1]);
        expect(recorder.writes).toEqual([]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.listener-bound an onCrash that never settles meets exit 450 ms after the crash",
    async () => {
      const recorder = recordingHost();
      const listener = recordedOnCrash();
      const subject = holding(recorder, { onCrash: listener.onCrash });
      await subject.run(["hold", "--json"]);
      jest.useFakeTimers();
      try {
        recorder.crash();
        await listener.called;
        await advance(exactStopBound - 1);
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
      `IP09.listener-fails an onCrash that ${name} still meets exit 1 without waiting for the bound`,
      async () => {
        const recorder = recordingHost();
        const facts: EmergencyFacts[] = [];
        const subject = holding(recorder, {
          onCrash,
          emergencyRecord: (fact) => facts.push(fact),
        });
        const one = await heldRun(subject);
        jest.useFakeTimers();
        try {
          recorder.crash();
          expect(await until(() => recorder.exits.length > 0)).toBe(true);
          expect(recorder.exits).toEqual([1]);
          expect(facts).toHaveLength(1);
          expect(recorder.writes).toEqual([]);
        } finally {
          jest.useRealTimers();
          one.gate.returned.resolve();
        }
        await one.done;
      },
      timeout,
    );

  test(
    "IP09.second-crash-exits-at-once a second crash during the wait exits at once, exits only once, and calls no onCrash again",
    async () => {
      const recorder = recordingHost();
      const facts: EmergencyFacts[] = [];
      const listener = recordedOnCrash();
      const subject = holding(recorder, {
        onCrash: listener.onCrash,
        emergencyRecord: (fact) => facts.push(fact),
      });
      const one = await heldRun(subject);
      jest.useFakeTimers();
      try {
        recorder.crash();
        await turns();
        expect(recorder.exits).toEqual([]);
        recorder.crash();
        expect(recorder.exits).toEqual([1]);
        await advance(exactStopBound);
        expect(recorder.exits).toEqual([1]);
        expect(listener.calls).toHaveLength(1);
        expect(facts).toHaveLength(1);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.signal-during-wait a stop signal during the wait exits 1 at once and only once",
    async () => {
      const recorder = recordingHost();
      const kills: string[] = [];
      const listener = recordedOnCrash();
      const subject = holding(recorder, { kills, onCrash: listener.onCrash });
      const one = await heldRun(subject);
      jest.useFakeTimers();
      try {
        recorder.crash();
        await turns();
        expect(kills).toHaveLength(1);
        recorder.signal("SIGTERM");
        expect(recorder.exits).toEqual([1]);
        expect(kills).toHaveLength(2);
        listener.settle.resolve();
        await advance(exactStopBound);
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.crash-during-stop a crash during a stop's settle decides the exit: 1, after onCrash, never the stop's code",
    async () => {
      const recorder = recordingHost();
      const listener = recordedOnCrash();
      const subject = holding(recorder, {
        stopSettleHangs: true,
        onCrash: listener.onCrash,
      });
      const one = await heldRun(subject);
      jest.useFakeTimers();
      try {
        recorder.signal("SIGTERM");
        await advance(100);
        recorder.crash();
        await listener.called;
        expect(listener.calls).toHaveLength(1);
        await advance(exactStopBound - 1);
        expect(recorder.exits).toEqual([]);
        await advance(1);
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.crash-during-stop-no-listener with no onCrash, a crash during a stop wait exits 1 at once",
    async () => {
      const recorder = recordingHost();
      const subject = holding(recorder, { stopSettleHangs: true });
      const one = await heldRun(subject);
      jest.useFakeTimers();
      try {
        recorder.signal("SIGTERM");
        await advance(100);
        expect(recorder.exits).toEqual([]);
        recorder.crash();
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.call-during-wait a call made during the wait never starts its run and stays pending",
    async () => {
      const recorder = recordingHost();
      const listener = recordedOnCrash();
      const subject = holding(recorder, { onCrash: listener.onCrash });
      await subject.run(["hold", "--json"]);
      jest.useFakeTimers();
      try {
        recorder.crash();
        const late = subject.start();
        const settled = { late: false };
        void late.done.then(() => {
          settled.late = true;
        });
        listener.settle.resolve();
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        expect(recorder.exits).toEqual([1]);
        expect(subject.entries).toHaveLength(1);
        expect(settled.late).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    },
    timeout,
  );

  test(
    "IP09.abort-reentry a crash raised by an abort observer while the first crash is stopping neither skips onCrash nor ends the wait",
    async () => {
      const recorder = recordingHost();
      const controls: RunControl[] = [];
      const facts: EmergencyFacts[] = [];
      const listener = recordedOnCrash();
      const exitsAtCall: number[][] = [];
      const subject = holding(recorder, {
        controls,
        onCrash: (error) => {
          exitsAtCall.push([...recorder.exits]);
          return listener.onCrash(error);
        },
        emergencyRecord: (fact) => facts.push(fact),
      });
      const one = await heldRun(subject);
      const [control] = controls;
      if (!control) throw new Error("No run attached programs.");
      control.signal.addEventListener(
        "abort",
        () => {
          recorder.crash(new Error("Planted crash from an abort observer."));
        },
        { once: true },
      );
      jest.useFakeTimers();
      try {
        const error = new Error("Planted crash with a run in flight.");
        recorder.crash(error);
        await listener.called;
        expect(listener.calls).toEqual([[error]]);
        expect(exitsAtCall).toEqual([[]]);
        expect(facts).toHaveLength(1);
        await turns();
        expect(recorder.exits).toEqual([]);
        listener.settle.resolve();
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.record-reentry a crash raised while an emergency record is written waits for the record, then onCrash, then its wait",
    async () => {
      const recorder = recordingHost();
      const steps: string[] = [];
      const listener = recordedOnCrash();
      const subject = holding(recorder, {
        onCrash: (error) => {
          steps.push("listener");
          return listener.onCrash(error);
        },
        emergencyRecord: () => {
          steps.push("record started");
          recorder.crash(new Error("Planted crash while recording."));
          steps.push("record written");
        },
      });
      const one = await heldRun(subject);
      jest.useFakeTimers();
      try {
        const error = new Error("Planted crash with a run in flight.");
        recorder.crash(error);
        await listener.called;
        expect(steps).toEqual(["record started", "record written", "listener"]);
        expect(listener.calls).toEqual([[error]]);
        await turns();
        expect(recorder.exits).toEqual([]);
        listener.settle.resolve();
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.signal-while-stopping stop signals raised while the crash writes its records do not take the exit",
    async () => {
      const recorder = recordingHost();
      const steps: string[] = [];
      const listener = recordedOnCrash();
      const subject = holding(recorder, {
        onCrash: (error) => {
          steps.push("listener");
          return listener.onCrash(error);
        },
        emergencyRecord: () => {
          steps.push("record started");
          recorder.signal("SIGTERM");
          recorder.signal("SIGTERM");
          steps.push("record written");
        },
      });
      const one = await heldRun(subject);
      jest.useFakeTimers();
      try {
        recorder.crash();
        await listener.called;
        expect(steps).toEqual(["record started", "record written", "listener"]);
        expect(recorder.exits).toEqual([]);
        listener.settle.resolve();
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.listener-reentry a crash raised inside one entry's onCrash still lets every entry's onCrash be called once, and exit waits for both",
    async () => {
      const recorder = recordingHost();
      const first = recordedOnCrash();
      const second = recordedOnCrash();
      const raising = (error: unknown) => {
        recorder.crash(new Error("Planted crash from inside onCrash."));
        return first.onCrash(error);
      };
      await holding(recorder, { onCrash: raising }).run(["hold"]);
      await holding(recorder, { onCrash: second.onCrash }).run(["hold"]);
      jest.useFakeTimers();
      try {
        const error = new Error("Planted crash after two entries ran.");
        recorder.crash(error);
        await Promise.all([first.called, second.called]);
        expect(first.calls).toEqual([[error]]);
        expect(second.calls).toEqual([[error]]);
        expect(recorder.exits).toEqual([]);
        first.settle.resolve();
        await turns();
        expect(recorder.exits).toEqual([]);
        second.settle.resolve();
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
      }
    },
    timeout,
  );

  const raisedWhileKilling = [
    [
      "kill-reentry",
      "a crash raised while a run's programs are killed",
      (recorder: ReturnType<typeof recordingHost>) => {
        recorder.crash(new Error("Planted crash from a kill."));
      },
    ],
    [
      "kill-signal",
      "stop signals raised while a run's programs are killed",
      (recorder: ReturnType<typeof recordingHost>) => {
        recorder.signal("SIGTERM");
        recorder.signal("SIGTERM");
      },
    ],
  ] as const;
  for (const [name, what, raise] of raisedWhileKilling)
    test(
      `IP09.${name} ${what} neither skips onCrash nor takes the exit`,
      async () => {
        const recorder = recordingHost();
        const listener = recordedOnCrash();
        const raised = { count: 0 };
        const exitsAtCall: number[][] = [];
        const subject = holding(recorder, {
          onKill: () => {
            raised.count += 1;
            if (raised.count === 1) raise(recorder);
          },
          onCrash: (error) => {
            exitsAtCall.push([...recorder.exits]);
            return listener.onCrash(error);
          },
        });
        const one = await heldRun(subject);
        jest.useFakeTimers();
        try {
          const error = new Error("Planted crash with a run in flight.");
          recorder.crash(error);
          await listener.called;
          expect(listener.calls).toEqual([[error]]);
          expect(exitsAtCall).toEqual([[]]);
          await turns();
          expect(recorder.exits).toEqual([]);
          listener.settle.resolve();
          expect(await until(() => recorder.exits.length > 0)).toBe(true);
          expect(recorder.exits).toEqual([1]);
        } finally {
          jest.useRealTimers();
          one.gate.returned.resolve();
        }
        await one.done;
      },
      timeout,
    );

  test(
    "IP09.abort-signal stop signals raised by an abort observer while the crash is stopping do not take the exit",
    async () => {
      const recorder = recordingHost();
      const controls: RunControl[] = [];
      const listener = recordedOnCrash();
      const exitsAtCall: number[][] = [];
      const subject = holding(recorder, {
        controls,
        onCrash: (error) => {
          exitsAtCall.push([...recorder.exits]);
          return listener.onCrash(error);
        },
      });
      const one = await heldRun(subject);
      const [control] = controls;
      if (!control) throw new Error("No run attached programs.");
      control.signal.addEventListener(
        "abort",
        () => {
          recorder.signal("SIGTERM");
          recorder.signal("SIGTERM");
        },
        { once: true },
      );
      jest.useFakeTimers();
      try {
        recorder.crash();
        await listener.called;
        expect(exitsAtCall).toEqual([[]]);
        await turns();
        expect(recorder.exits).toEqual([]);
        listener.settle.resolve();
        expect(await until(() => recorder.exits.length > 0)).toBe(true);
        expect(recorder.exits).toEqual([1]);
      } finally {
        jest.useRealTimers();
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  test(
    "IP09.no-listener-unchanged with no onCrash a crash still exits 1 at once",
    async () => {
      const recorder = recordingHost();
      const facts: EmergencyFacts[] = [];
      const subject = holding(recorder, {
        emergencyRecord: (fact) => facts.push(fact),
      });
      const one = await heldRun(subject);
      try {
        recorder.crash();
        expect(recorder.exits).toEqual([1]);
        expect(facts).toHaveLength(1);
        expect(recorder.writes).toEqual([]);
      } finally {
        one.gate.returned.resolve();
      }
      await one.done;
    },
    timeout,
  );

  for (const last of ["second", "first"] as const)
    test(
      `IP09.each-entry-listener two entries on one host each have their onCrash called once, and exit waits for both, when the ${last} settles last`,
      async () => {
        const recorder = recordingHost();
        const first = recordedOnCrash();
        const second = recordedOnCrash();
        await holding(recorder, { onCrash: first.onCrash }).run(["hold"]);
        await holding(recorder, { onCrash: second.onCrash }).run(["hold"]);
        const [early, late] =
          last === "second" ? [first, second] : [second, first];
        jest.useFakeTimers();
        try {
          const error = new Error("Planted crash after two entries ran.");
          recorder.crash(error);
          await Promise.all([first.called, second.called]);
          expect(first.calls).toEqual([[error]]);
          expect(second.calls).toEqual([[error]]);
          early.settle.resolve();
          await turns();
          expect(recorder.exits).toEqual([]);
          late.settle.resolve();
          expect(await until(() => recorder.exits.length > 0)).toBe(true);
          expect(recorder.exits).toEqual([1]);
        } finally {
          jest.useRealTimers();
        }
      },
      timeout,
    );

  test(
    "IP09.bound-from-call synchronous work inside onCrash counts against the 450 ms wait",
    async () => {
      const recorder = recordingHost();
      const listener = recordedOnCrash();
      const busy = 300;
      const subject = holding(recorder, {
        onCrash: (error) => {
          jest.advanceTimersByTime(busy);
          return listener.onCrash(error);
        },
      });
      await subject.run(["hold", "--json"]);
      jest.useFakeTimers();
      try {
        const crashedAt = performance.now();
        recorder.crash();
        await listener.called;
        await advance(exactStopBound - busy - 1);
        expect(recorder.exits).toEqual([]);
        await advance(1);
        expect(recorder.exits).toEqual([1]);
        expect(recorder.exitedAt.map((at) => at - crashedAt)).toEqual([
          exactStopBound,
        ]);
      } finally {
        jest.useRealTimers();
      }
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
