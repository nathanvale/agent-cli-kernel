// Part 3: the kernel side of the diagnostics status seam (LIFE-7 step 1,
// LIFE-9 step 2, DIAG-1 to DIAG-5, DIAG-14). Real CLI processes through the
// labelled fixture `st` and its throwaway status-reporting add-on; expected
// values are test-owned literals from the frozen contract text.
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { comparableEnvelope } from "../../../starters/contract3/src/kernel/comparison.ts";
import { programsAddon } from "../../../starters/contract3/src/addons/programs/index.ts";
import {
  command,
  contractFor,
} from "../../../starters/contract3/src/kernel/index.ts";
import type {
  DiagnosticsCapability,
  RunAddon,
} from "../../../starters/contract3/src/kernel/index.ts";
import { runProcessOn } from "../../../starters/contract3/src/kernel/lifecycle.ts";
import {
  envelopeOf,
  exitWithin,
  launch,
  release,
  resultOf,
  text,
} from "./harness.ts";
import type { Observed } from "./harness.ts";
import { flushBound, stopBound } from "./oracle.ts";
import { recordingHost } from "./recording-host.ts";

const timeout = 30_000;
const tolerance = 100;
const statusCli = join(import.meta.dir, "fixtures/status-cli.ts");
const payloadMarker = "FX-STATUS-PAYLOAD";

// DIAG-2 and DIAG-3, test-owned. `ownAvailable` and `ownUnavailable` are what
// the fixture add-on reports; a valid status reaches the envelope unchanged.
const ownAvailable = {
  status: "available",
  file: "/private/state/st/diagnostics/run.log",
  sinkFailure: null,
  droppedRecords: 0,
  unflushedRecords: 0,
  truncatedRecords: 0,
  countsComplete: true,
  closed: true,
};
const ownUnavailable = {
  status: "unavailable",
  reason: "status-unavailable",
  trusted: { droppedRecords: 2, countsComplete: false },
};
// The kernel's replacements: an invalid value, and a status it could not get.
const statusInvalid = {
  status: "unavailable",
  reason: "status-invalid",
  trusted: {},
};
const statusUnavailable = {
  status: "unavailable",
  reason: "status-unavailable",
  trusted: {},
};

// Provisional reading (coordinator ruling, to be judged by the T5 reviewer):
// a usage refusal and a deadline before start of a declaring command carry
// no key. If the reading is overturned, change this one line to
// `ownAvailable` (and the kernel's `statusOnPreHandlerRefusal` to true).
const preDispatchStatus: unknown = undefined;

async function runStatus(
  argv: readonly string[],
  status: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Observed> {
  const launched = await launch({
    script: statusCli,
    argv,
    env: { FX_STATUS: status, ...env },
  });
  try {
    return await exitWithin(launched);
  } finally {
    await release(launched);
  }
}

function parsed(observed: Observed) {
  expect(observed.stderr.byteLength).toBe(0);
  const envelope = envelopeOf(observed.stdout);
  return { envelope, result: resultOf(envelope) };
}
function line(observed: Observed, prefix: string) {
  return observed.ledger.find((entry) => entry.startsWith(prefix));
}

describe("DS01 and DS02 a valid status reaches the envelope unchanged", () => {
  test(
    "DS01.status-available-passes",
    async () => {
      const observed = await runStatus(["report", "--json"], "available");
      const { envelope, result } = parsed(observed);
      expect(envelope.diagnostics).toEqual(ownAvailable);
      expect(result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(observed.code).toBe(0);
    },
    timeout,
  );
  test(
    "DS02.status-unavailable-keeps-trusted-fields",
    async () => {
      const observed = await runStatus(["report", "--json"], "unavailable");
      const { envelope } = parsed(observed);
      expect(envelope.diagnostics).toEqual(ownUnavailable);
      expect(observed.code).toBe(0);
    },
    timeout,
  );
});

// W06, DIAG-4, DIAG-5: a diagnostics fault alone changes nothing but the
// status. The available run is the valid twin.
describe("W06 a diagnostics fault never takes the fallback", () => {
  for (const [mode, replaced] of [
    ["invalid", statusInvalid],
    ["throws", statusUnavailable],
    ["never", statusUnavailable],
    ["no-freeze", statusUnavailable],
  ] as const)
    test(
      `W06.diagnostics-fault-no-fallback ${mode}`,
      async () => {
        const twin = parsed(await runStatus(["report", "--json"], "available"));
        const observed = await runStatus(["report", "--json"], mode);
        const { envelope, result } = parsed(observed);
        expect(envelope.diagnostics).toEqual(replaced);
        expect(result.causeCode).toBe("SUCCESS_UNCHANGED");
        expect(observed.code).toBe(0);
        // Message, data, effects, exit and recovery as in the twin.
        expect(comparableEnvelope(envelope)).toBe(
          comparableEnvelope(twin.envelope),
        );
        expect(text(observed.stdout)).not.toContain(payloadMarker);
      },
      timeout,
    );
});

// LIFE-9 step 2: the fallback carries the frozen, validated status.
describe("F02 the fallback includes the frozen diagnostics", () => {
  for (const [variant, argv, mode, expected] of [
    ["available", ["report", "--bad", "--json"], "available", ownAvailable],
    ["invalid", ["report", "--bad", "--json"], "invalid", statusInvalid],
    [
      "handler-throws",
      ["report", "--throw", "--json"],
      "available",
      ownAvailable,
    ],
  ] as const)
    test(
      `F02.diagnostics-in-fallback ${variant}`,
      async () => {
        const observed = await runStatus(argv, mode);
        const { envelope, result } = parsed(observed);
        expect(result.causeCode).toBe("INTERNAL_RESULT_UNCHANGED");
        expect(result.data).toBeNull();
        expect(observed.code).toBe(1);
        expect(envelope.diagnostics).toEqual(expected);
        expect(observed.stdout.byteLength).toBeLessThanOrEqual(16_384);
        expect(text(observed.stdout)).not.toContain(payloadMarker);
      },
      timeout,
    );
});

describe("DS03 and DS10 the freeze is bounded at 500 ms", () => {
  test(
    "DS03.freeze-bounded-at-500",
    async () => {
      const observed = await runStatus(["report", "--json"], "never");
      const started = Number(line(observed, "freeze-start ")?.split(" ")[2]);
      expect(Number.isFinite(started)).toBe(true);
      const emitted = (observed.firstStdoutAt ?? 0) - started;
      expect(emitted).toBeGreaterThanOrEqual(flushBound);
      expect(emitted).toBeLessThanOrEqual(flushBound + tolerance);
      expect(parsed(observed).envelope.diagnostics).toEqual(statusUnavailable);
    },
    timeout,
  );
  test(
    "DS10.slow-freeze-within-budget",
    async () => {
      const observed = await runStatus(["report", "--json"], "slow");
      expect(parsed(observed).envelope.diagnostics).toEqual(ownAvailable);
      expect(line(observed, "freeze-start ")?.split(" ")[1]).toBe("500");
    },
    timeout,
  );
});

// DIAG-1: absent only when neither requested nor triggered.
describe("DS04 and DS05 when the key is absent", () => {
  test(
    "DS04.key-absent-without-reporter",
    async () => {
      const plain = await runStatus(["plain", "--json"], "available");
      expect(parsed(plain).envelope).not.toHaveProperty("diagnostics");
      expect(plain.ledger.some((entry) => entry.startsWith("status-"))).toBe(
        false,
      );
      // A declaring command whose handler never records still reports.
      const silent = await runStatus(["report", "--json"], "available");
      expect(silent.ledger.some((entry) => entry.startsWith("record "))).toBe(
        false,
      );
      expect(parsed(silent).envelope.diagnostics).toEqual(ownAvailable);
    },
    timeout,
  );
  // An unknown command declares nothing: no key under either reading.
  test(
    "DS05.pre-dispatch-results-carry-no-key routing",
    async () => {
      const observed = await runStatus(["nope", "--json"], "available");
      const { envelope, result } = parsed(observed);
      expect(result.outcome).toBe("refused");
      expect(envelope).not.toHaveProperty("diagnostics");
      expect(observed.ledger.some((entry) => entry.startsWith("status-"))).toBe(
        false,
      );
    },
    timeout,
  );
  for (const [variant, argv, env] of [
    ["usage", ["report", "--wait-ms", "0", "--json"], {}],
    [
      "deadline-before-start",
      ["report", "--deadline-ms", "1000", "--json"],
      { FX_CLOCK_JUMP_MS: "1000000" },
    ],
  ] as const)
    test(
      `DS05.pre-dispatch-results-carry-no-key ${variant}`,
      async () => {
        const observed = await runStatus(argv, "available", env);
        const { envelope, result } = parsed(observed);
        expect(result.outcome).toBe("refused");
        expect(envelope.diagnostics).toEqual(preDispatchStatus);
        expect(observed.ledger).not.toContain("handler-entered");
        // A status is frozen exactly when the reading gives one.
        expect(line(observed, "freeze-start ") !== undefined).toBe(
          preDispatchStatus !== undefined,
        );
      },
      timeout,
    );
});

describe("DS06 and DS07 the order of freezing (DIAG-14)", () => {
  test(
    "DS06.result-frozen-before-flush",
    async () => {
      const observed = await runStatus(
        ["report", "--record", "--program", "--json"],
        "available",
      );
      const order = observed.ledger
        .map((entry) => entry.split(" ")[0] ?? "")
        .filter((entry) =>
          [
            "handler-done",
            "program-done",
            "result-built",
            "freeze-start",
            "status-settle",
          ].includes(entry),
        );
      // Owned programs settled and the result built before the flush; on
      // normal completion `freeze` replaces the add-on's settle.
      expect(order).toEqual([
        "program-done",
        "handler-done",
        "result-built",
        "freeze-start",
      ]);
      expect(parsed(observed).envelope.diagnostics).toEqual(ownAvailable);
    },
    timeout,
  );
  test(
    "DS07.deadline-path-carries-status",
    async () => {
      const observed = await runStatus(
        ["report", "--wait-ms", "2000", "--deadline-ms", "300", "--json"],
        "available",
      );
      const { envelope, result } = parsed(observed);
      expect(result.causeCode).toBe("DOMAIN_DEADLINE_UNCHANGED");
      expect(observed.code).toBe(3);
      expect(envelope.diagnostics).toEqual(ownAvailable);
      const order = observed.ledger.filter(
        (entry) =>
          entry === "result-built" ||
          entry.startsWith("freeze-start") ||
          entry.startsWith("status-settle"),
      );
      expect(order.map((entry) => entry.split(" ")[0])).toEqual([
        "status-settle",
        "result-built",
        "freeze-start",
      ]);
    },
    timeout,
  );
});

// DIAG-15: a forced termination promises no status.
describe("DS08 the stop path freezes no status", () => {
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)
    test(
      `DS08.stop-path-promises-no-status ${signal}`,
      async () => {
        const launched = await launch({
          script: statusCli,
          argv: ["report", "--wait-ms", "2000", "--json"],
          env: { FX_STATUS: "available" },
        });
        try {
          await launched.barrier("handler-entered");
          const sent = launched.signal(signal);
          const observed = await exitWithin(launched);
          expect(observed.code).toBe(code);
          expect(observed.stdout.byteLength).toBe(0);
          expect(observed.stderr.byteLength).toBe(0);
          expect(observed.exitedAt - sent).toBeLessThanOrEqual(
            stopBound + tolerance,
          );
          expect(line(observed, "freeze-start ")).toBeUndefined();
        } finally {
          await release(launched);
        }
      },
      timeout,
    );
});

describe("DS09 one status-reporting add-on per command", () => {
  test("DS09.one-reporter-per-command", () => {
    const reporter = <C>(addon: RunAddon<C>): RunAddon<C> => ({
      ...addon,
      reportsStatus: true,
    });
    const both = command({
      identity: "two.both",
      route: ["both"],
      summary: "Declare two capabilities.",
      input: {
        arguments: [],
        options: [],
        constraints: [],
        deadlineSupported: false,
        additionalArguments: false,
        additionalOptions: false,
      },
      capabilities: { diagnostics: true, programs: true },
      run: (_input, context) =>
        context.result(
          { commandIdentity: "two.both", causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Done.",
            data: null,
            effects: {
              completed: [],
              remaining: [],
              uncertain: [],
              inventoryComplete: true,
            },
          },
        ),
    });
    const contract = contractFor({
      cli: "two",
      commands: [both],
      installedAddons: ["diagnostics", "programs"],
    });
    const diagnostics: RunAddon<DiagnosticsCapability> = {
      attach: () => ({
        capability: { record: () => undefined },
        settle: () => Promise.resolve(true),
        killNow: () => undefined,
      }),
    };
    const host = () => recordingHost().host;
    expect(() =>
      runProcessOn(
        contract,
        {
          addons: {
            diagnostics: reporter(diagnostics),
            programs: programsAddon(),
          },
        },
        host,
      ),
    ).not.toThrow();
    expect(() =>
      runProcessOn(
        contract,
        {
          addons: {
            diagnostics: reporter(diagnostics),
            programs: reporter(programsAddon()),
          },
        },
        host,
      ),
    ).toThrow("more than one status-reporting add-on");
  });
});

// X-K5 (swarm triage): a settle that throws is an unconfirmed termination,
// never a crash. Fixture: the programs add-on's settle throws synchronously.
describe("K3K5 a settle fault keeps the exit path", () => {
  const settleThrows = { FX_SETTLE_THROWS: "1" };
  test(
    "K3K5.settle-fault-keeps-exit-path sigterm",
    async () => {
      const launched = await launch({
        script: statusCli,
        argv: ["report", "--program", "--wait-ms", "2000", "--json"],
        env: { FX_STATUS: "available", ...settleThrows },
      });
      try {
        await launched.barrier("program-done");
        const sent = launched.signal("SIGTERM");
        const observed = await exitWithin(launched);
        expect(observed.signal).toBeNull();
        expect(observed.code).toBe(143);
        expect(observed.stdout.byteLength).toBe(0);
        expect(observed.stderr.byteLength).toBe(0);
        expect(observed.exitedAt - sent).toBeLessThanOrEqual(
          stopBound + tolerance,
        );
      } finally {
        await release(launched);
      }
    },
    timeout,
  );
  test(
    "K3K5.settle-fault-keeps-exit-path normal",
    async () => {
      const observed = await runStatus(
        ["report", "--program", "--json"],
        "available",
        settleThrows,
      );
      const { result } = parsed(observed);
      // LIFE-11 normal row: termination not confirmed, so a handoff.
      expect(result.causeCode).toBe("INTERNAL_RESULT_UNCHANGED");
      expect(result).toHaveProperty("handoff");
      expect(observed.code).toBe(1);
      expect(observed.ledger).toContain("settle-throws");
    },
    timeout,
  );
  test(
    "K3K5.settle-fault-keeps-exit-path deadline",
    async () => {
      const observed = await runStatus(
        [
          "report",
          "--program",
          "--wait-ms",
          "2000",
          "--deadline-ms",
          "300",
          "--json",
        ],
        "available",
        settleThrows,
      );
      const { result } = parsed(observed);
      expect(result.causeCode).toBe("DOMAIN_DEADLINE_UNCHANGED");
      expect(observed.code).toBe(3);
      expect(observed.ledger).toContain("settle-throws");
    },
    timeout,
  );
});

// Seam review follow-ups (contract S1, S2 and the test gaps).
describe("seam review: hostile statuses and a failing reporter attach", () => {
  test(
    "F02.diagnostics-in-fallback oversize status",
    async () => {
      const observed = await runStatus(
        ["report", "--bad", "--json"],
        "oversize",
      );
      const { envelope, result } = parsed(observed);
      expect(result.causeCode).toBe("INTERNAL_RESULT_UNCHANGED");
      expect(observed.code).toBe(1);
      expect(observed.stdout.byteLength).toBeLessThanOrEqual(16_384);
      expect(envelope.diagnostics).toEqual(statusUnavailable);
    },
    timeout,
  );
  test(
    "F02.diagnostics-in-fallback owned program survived",
    async () => {
      const observed = await runStatus(
        ["report", "--program", "--json"],
        "available",
        { FX_SETTLE_THROWS: "1" },
      );
      const { envelope, result } = parsed(observed);
      expect(result.causeCode).toBe("INTERNAL_RESULT_UNCHANGED");
      expect(envelope.diagnostics).toEqual(ownAvailable);
    },
    timeout,
  );
  for (const [mode, expected] of [
    ["accessor", undefined],
    ["nonjson", statusInvalid],
  ] as const)
    test(
      `W06.diagnostics-fault-no-fallback ${mode}`,
      async () => {
        const twin = parsed(await runStatus(["report", "--json"], "available"));
        const observed = await runStatus(["report", "--json"], mode);
        const { envelope, result } = parsed(observed);
        expect(result.causeCode).toBe("SUCCESS_UNCHANGED");
        expect(observed.code).toBe(0);
        expect(comparableEnvelope(envelope)).toBe(
          comparableEnvelope(twin.envelope),
        );
        // The accessor may be copied valid or invalid; either way the copy,
        // not a second read, is what the envelope carries.
        if (expected) expect(envelope.diagnostics).toEqual(expected);
        else
          expect(["available", "unavailable"]).toContain(
            String(Reflect.get(Object(envelope.diagnostics), "status")),
          );
      },
      timeout,
    );
  test(
    "DS11.reporter-attach-fault-never-crashes",
    async () => {
      const observed = await runStatus(
        ["report", "--record", "--json"],
        "attach-throws",
      );
      const { envelope, result } = parsed(observed);
      expect(result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(observed.code).toBe(0);
      expect(observed.ledger).toContain("handler-done");
      expect(envelope.diagnostics).toEqual(statusUnavailable);
    },
    timeout,
  );
});
