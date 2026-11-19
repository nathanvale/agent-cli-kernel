import { describe, expect, test } from "bun:test";
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
import {
  deferred,
  holdContract,
  recordingHost,
  shell,
  turns,
  until,
} from "./recording-host.ts";

const timeout = 30_000;
const stops = [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const;

function watched(controls: RunControl[]): RunAddon<ProgramsCapability> {
  const inner = programsAddon();
  return {
    attach(run) {
      controls.push(run);
      return inner.attach(run);
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
  controls: RunControl[],
  emergencyRecord?: (facts: EmergencyFacts) => void,
) {
  const queue: ReturnType<typeof held>[] = [];
  const entries: string[] = [];
  const entry = runInProcessOn(
    holdContract(async (programs) => {
      const gate = queue.shift();
      entries.push("entered");
      await programs.inspect(shell("exit 0"));
      if (!gate) return;
      gate.entered.resolve();
      await gate.returned.promise;
    }),
    emergencyRecord
      ? { addons: { programs: watched(controls) }, emergencyRecord }
      : { addons: { programs: watched(controls) } },
    () => recorder.host,
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
      const subject = holding(recorder, controls);
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
      const subject = holding(recorder, []);
      await subject.run(["hold", "--json"]);
      await subject.run(["hold", "--json"]);
      await subject.run(["hold", "--json"]);
      expect(recorder.installs).toEqual({ signal: 1, crash: 1 });
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
        const subject = holding(recorder, controls);
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
      const subject = holding(recorder, []);
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
});

describe("IP03 a crash records at most once for each run in flight", () => {
  test(
    "IP03.crash-records-run-in-flight one record for the run in flight, none for the finished run",
    async () => {
      const recorder = recordingHost();
      const facts: EmergencyFacts[] = [];
      const subject = holding(recorder, [], (fact) => facts.push(fact));
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
