import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { comparableEnvelope } from "../../../kernel/src/kernel/comparison.ts";
import { programsAddon } from "../../../kernel/src/addons/programs/index.ts";
import { command, contractFor } from "../../../kernel/src/kernel/index.ts";
import type {
  DiagnosticsCapability,
  RunAddon,
} from "../../../kernel/src/kernel/index.ts";
import { runProcessOn } from "../../../kernel/src/kernel/lifecycle.ts";
import {
  envelopeOf,
  exitWithin,
  launch,
  release,
  resultOf,
  text,
} from "./harness.ts";
import type { Observed } from "./harness.ts";
import {
  flushBound,
  stopBound,
  tolerance,
  unchangedEffects,
} from "./oracle.ts";
import { recordingHost } from "./recording-host.ts";

const timeout = 30_000;
const statusCli = join(import.meta.dir, "fixtures/status-cli.ts");
const payloadMarker = "FX-STATUS-PAYLOAD";

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
        expect(comparableEnvelope(envelope)).toBe(
          comparableEnvelope(twin.envelope),
        );
        expect(text(observed.stdout)).not.toContain(payloadMarker);
      },
      timeout,
    );
});

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

describe("DS04 and DS05 when the key is absent", () => {
  test(
    "DS04.key-absent-without-reporter",
    async () => {
      const plain = await runStatus(["plain", "--json"], "available");
      expect(parsed(plain).envelope).not.toHaveProperty("diagnostics");
      expect(plain.ledger.some((entry) => entry.startsWith("status-"))).toBe(
        false,
      );
      const silent = await runStatus(["report", "--json"], "available");
      expect(silent.ledger.some((entry) => entry.startsWith("record "))).toBe(
        false,
      );
      expect(parsed(silent).envelope.diagnostics).toEqual(ownAvailable);
    },
    timeout,
  );
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
        expect("diagnostics" in envelope).toBe(preDispatchStatus !== undefined);
        expect(envelope.diagnostics).toEqual(preDispatchStatus);
        expect(observed.ledger).not.toContain("handler-entered");
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
            effects: unchangedEffects,
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
      expect(result.causeCode).toBe(
        "DOMAIN_ST_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
      );
      expect(result).toHaveProperty("handoff");
      expect(observed.code).toBe(3);
      expect(observed.ledger).toContain("settle-throws");
    },
    timeout,
  );
});

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
      const twin = parsed(
        await runStatus(["report", "--record", "--json"], "available"),
      );
      expect(comparableEnvelope(envelope)).toBe(
        comparableEnvelope(twin.envelope),
      );
    },
    timeout,
  );
});

describe("DS05 refusals after the reporter attached (Part 4 repair R1)", () => {
  test(
    "DS05.pre-dispatch-results-carry-no-key capabilities refusal",
    async () => {
      const observed = await runStatus(["report", "--json"], "bad-capability");
      const { envelope, result } = parsed(observed);
      expect(result.causeCode).toBe("INTERNAL_PREPARATION");
      expect(
        observed.ledger.some((line) => line.startsWith("status-attach")),
      ).toBe(true);
      expect(observed.ledger).not.toContain("handler-entered");
      expect("diagnostics" in envelope).toBe(preDispatchStatus !== undefined);
      expect(envelope.diagnostics).toEqual(preDispatchStatus);
    },
    timeout,
  );
  test(
    "DS05.pre-dispatch-results-carry-no-key approval denial",
    async () => {
      const launched = await launch({
        argv: ["guarded-status", "--go", "--json"],
        state: true,
        env: { FX_APPROVAL: "deny" },
      });
      try {
        const observed = await exitWithin(launched);
        const { envelope, result } = parsed(observed);
        expect(result.causeCode).toBe("DOMAIN_AUTHORITY_REQUIRED");
        expect(observed.code).toBe(3);
        expect(
          observed.ledger.some((line) => line.startsWith("status-attach")),
        ).toBe(true);
        expect("diagnostics" in envelope).toBe(preDispatchStatus !== undefined);
        expect(envelope.diagnostics).toEqual(preDispatchStatus);
      } finally {
        await release(launched);
      }
    },
    timeout,
  );
});

test(
  "F02.diagnostics-in-fallback wide effects small status",
  async () => {
    const launched = await launch({
      argv: ["wide-status", "--json"],
      state: true,
      scenario: "corrupt:generic",
    });
    try {
      const observed = await exitWithin(launched);
      const { envelope, result } = parsed(observed);
      expect(result.causeCode).toBe("INTERNAL_RESULT_UNKNOWN");
      expect(result.effects).toEqual({
        completed: [],
        remaining: [],
        uncertain: [],
        inventoryComplete: false,
      });
      expect(observed.stdout.byteLength).toBeLessThanOrEqual(16_384);
      expect(envelope.diagnostics).toEqual(ownAvailable);
    } finally {
      await release(launched);
    }
  },
  timeout,
);

describe("K3K5 a rejected settle keeps the exit path", () => {
  const settleRejects = { FX_SETTLE_THROWS: "async" };
  test(
    "K3K5.settle-fault-keeps-exit-path async sigterm",
    async () => {
      const launched = await launch({
        script: statusCli,
        argv: ["report", "--program", "--wait-ms", "2000", "--json"],
        env: { FX_STATUS: "available", ...settleRejects },
      });
      try {
        await launched.barrier("program-done");
        launched.signal("SIGTERM");
        const observed = await exitWithin(launched);
        expect(observed.code).toBe(143);
        expect(observed.stdout.byteLength).toBe(0);
        expect(observed.stderr.byteLength).toBe(0);
      } finally {
        await release(launched);
      }
    },
    timeout,
  );
  for (const [variant, argv, cause, code] of [
    [
      "normal",
      ["report", "--program", "--json"],
      "INTERNAL_RESULT_UNCHANGED",
      1,
    ],
    [
      "deadline",
      [
        "report",
        "--program",
        "--wait-ms",
        "2000",
        "--deadline-ms",
        "300",
        "--json",
      ],
      "DOMAIN_ST_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
      3,
    ],
  ] as const)
    test(
      `K3K5.settle-fault-keeps-exit-path async ${variant}`,
      async () => {
        const observed = await runStatus(argv, "available", settleRejects);
        const { result } = parsed(observed);
        expect(result.causeCode).toBe(cause);
        expect(observed.code).toBe(code);
        expect(observed.ledger).toContain("settle-throws");
      },
      timeout,
    );
});

test(
  "DS12.status-never-changes-fallback-result",
  async () => {
    const fallbackOf = async (
      command: string,
      fileLength: number,
    ): Promise<Record<string, unknown>> => {
      const launched = await launch({
        argv: [command, "--json"],
        state: true,
        scenario: "corrupt:generic",
        env: {
          FX_WIDE_COUNT: "25",
          FX_STATUS_FILE_LENGTH: String(fileLength),
        },
      });
      try {
        const observed = await exitWithin(launched);
        const { envelope, result } = parsed(observed);
        expect(observed.code).toBe(Number(result.exitCode));
        expect(observed.stdout.byteLength).toBeLessThanOrEqual(16_384);
        return {
          causeCode: result.causeCode,
          effects: result.effects,
          exitCode: result.exitCode,
          diagnostics: envelope.diagnostics,
        };
      } finally {
        await release(launched);
      }
    };
    const none = await fallbackOf("wide", 0);
    expect(none.causeCode).toBe("INTERNAL_RESULT_COMPLETED");
    expect(Reflect.get(Object(none.effects), "inventoryComplete")).toBe(true);
    expect(none.diagnostics).toBeUndefined();
    const domain = (value: Record<string, unknown>) => ({
      causeCode: value.causeCode,
      effects: value.effects,
      exitCode: value.exitCode,
    });
    for (const [length, status] of [
      [0, ownAvailable],
      [4_000, statusUnavailable],
      [16_000, statusUnavailable],
    ] as const) {
      const twin = await fallbackOf("wide-status", length);
      expect(domain(twin)).toEqual(domain(none));
      expect(twin.diagnostics).toEqual(status);
    }
  },
  timeout,
);

describe("KF1.d and KF8 no key at the check-phase sites", () => {
  const preparation = {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "internal",
    exitCode: 1,
    causeCode: "INTERNAL_PREPARATION",
    effects: unchangedEffects,
  };
  async function guardedRun(
    status: string,
    approval: string,
    extra: readonly string[] = [],
  ) {
    const observed = await runStatus(["guarded", ...extra, "--json"], status, {
      FX_APPROVAL: approval,
    });
    return { observed, ...parsed(observed) };
  }
  async function expectTwinCarriesKey() {
    const twin = await guardedRun("available", "grant");
    expect(twin.observed.code).toBe(0);
    expect(twin.result.causeCode).toBe("SUCCESS_UNCHANGED");
    expect(twin.observed.ledger).toContain("handler-entered");
    expect(twin.envelope.diagnostics).toEqual(ownAvailable);
  }
  test(
    "KF1.d reporter-attach-fault-beside-approval-fault",
    async () => {
      const both = await guardedRun("attach-throws", "attach-throws");
      expect(both.observed.code).toBe(1);
      expect(both.result).toMatchObject({
        commandIdentity: "st.guarded",
        ...preparation,
      });
      expect(both.envelope).not.toHaveProperty("diagnostics");
      expect(both.observed.ledger).toContain("approval-attach");
      expect(both.observed.ledger).not.toContain("handler-entered");
      const twin = await guardedRun("attach-throws", "grant");
      expect(twin.observed.code).toBe(0);
      expect(twin.result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(twin.envelope.diagnostics).toEqual(statusUnavailable);
    },
    timeout,
  );
  test(
    "KF8.a check-phase-deadline-no-key",
    async () => {
      const late = await guardedRun("available", "delay", [
        "--deadline-ms",
        "50",
      ]);
      expect(late.observed.code).toBe(3);
      expect(late.result).toMatchObject({
        outcome: "refused",
        causeCode: "DOMAIN_DEADLINE_BEFORE_START",
      });
      expect(late.envelope).not.toHaveProperty("diagnostics");
      expect(late.observed.ledger).toContain("check-start");
      expect(late.observed.ledger).not.toContain("handler-entered");
      expect(line(late.observed, "freeze-start ")).toBeUndefined();
      await expectTwinCarriesKey();
    },
    timeout,
  );
  for (const variant of ["reject", "sync-throw"] as const)
    test(
      `KF8.b thrown-check-no-key ${variant}`,
      async () => {
        const thrown = await guardedRun("available", variant);
        expect(thrown.observed.code).toBe(1);
        expect(thrown.result).toMatchObject(preparation);
        expect(thrown.envelope).not.toHaveProperty("diagnostics");
        expect(thrown.observed.ledger).toContain("check-start");
        expect(thrown.observed.ledger).not.toContain("handler-entered");
        await expectTwinCarriesKey();
      },
      timeout,
    );
  test(
    "KF8.c attach-fault-no-key: guards the add-on order (approval attaches before the status reporter)",
    async () => {
      const fault = await guardedRun("available", "attach-throws");
      expect(fault.observed.code).toBe(1);
      expect(fault.result).toMatchObject(preparation);
      expect(fault.envelope).not.toHaveProperty("diagnostics");
      expect(fault.observed.ledger).toContain("approval-attach");
      expect(line(fault.observed, "freeze-start ")).toBeUndefined();
      await expectTwinCarriesKey();
    },
    timeout,
  );
});

describe("KF6 the human Diagnostics line", () => {
  async function human(
    argv: readonly string[],
    status: string,
    env: Readonly<Record<string, string>> = {},
  ) {
    const observed = await runStatus(argv, status, env);
    return {
      code: observed.code,
      stdout: text(observed.stdout),
      stderr: text(observed.stderr),
      ledger: observed.ledger,
    };
  }
  const lastLine = (value: string) => value.split("\n").at(-2);
  const lineCount = (value: string) => value.split("\n").length - 1;
  async function machineTwin(
    argv: readonly string[],
    status: string,
    env: Readonly<Record<string, string>> = {},
  ) {
    const observed = await runStatus([...argv, "--json"], status, env);
    const { envelope, result } = parsed(observed);
    expect(text(observed.stdout)).not.toContain("Diagnostics:");
    return { code: observed.code, envelope, result };
  }
  for (const [variant, status, expected] of [
    [
      "incomplete",
      "incomplete",
      "Diagnostics: /private/run.log (incomplete: flush-timeout)",
    ],
    ["no-file", "no-file", "Diagnostics: no log file (setup)"],
    ["available", "available", `Diagnostics: ${ownAvailable.file}`],
  ] as const)
    test(
      `KF6.a human-line-available ${variant}`,
      async () => {
        const run = await human(["report"], status);
        expect({ code: run.code, stderr: run.stderr }).toEqual({
          code: 0,
          stderr: "",
        });
        expect(lastLine(run.stdout)).toBe(expected);
        const before = run.stdout.slice(0, -(expected.length + 1));
        expect(before).not.toBe("");
        expect(before).not.toContain("Diagnostics:");
      },
      timeout,
    );
  test(
    "KF6.a twin: a command that declares no diagnostics prints no line",
    async () => {
      const run = await human(["plain"], "available");
      expect(run.code).toBe(0);
      expect(run.stdout).not.toBe("");
      expect(run.stdout + run.stderr).not.toContain("Diagnostics:");
    },
    timeout,
  );
  for (const [variant, status, expected] of [
    ["invalid", "invalid", "Diagnostics: unavailable (status-invalid)"],
    ["throws", "throws", "Diagnostics: unavailable (status-unavailable)"],
    [
      "trusted-file",
      "trusted-file",
      "Diagnostics: unavailable (status-invalid); log file /private/run.log",
    ],
    [
      "trusted-file-null",
      "trusted-file-null",
      "Diagnostics: unavailable (status-unavailable)",
    ],
    [
      "trusted-sink",
      "trusted-sink",
      "Diagnostics: unavailable (status-invalid)",
    ],
  ] as const)
    test(
      `KF6.b human-line-unavailable ${variant}`,
      async () => {
        const run = await human(["report"], status);
        expect({ code: run.code, stderr: run.stderr }).toEqual({
          code: 0,
          stderr: "",
        });
        expect(lastLine(run.stdout)).toBe(expected);
      },
      timeout,
    );
  for (const [variant, argv] of [
    ["handler-throws", ["report", "--throw"]],
    ["deadline", ["report", "--wait-ms", "2000", "--deadline-ms", "100"]],
    ["host-refusal", ["report", "--refuse"]],
  ] as const)
    test(
      `KF6.c human-line-on-failure-after-entry ${variant}`,
      async () => {
        const run = await human(argv, "available");
        const twin = await machineTwin(argv, "available");
        expect(twin.envelope.diagnostics).toEqual(ownAvailable);
        expect(lineCount(run.stderr)).toBe(1);
        expect(run.stdout).toBe(`Diagnostics: ${ownAvailable.file}\n`);
      },
      timeout,
    );
  test(
    "KF6.e line-never-changes-result: each human exit and cause equal the machine twin's",
    async () => {
      const variants: ReadonlyArray<readonly [readonly string[], string]> = [
        ...[
          "incomplete",
          "no-file",
          "available",
          "invalid",
          "throws",
          "trusted-file",
          "trusted-file-null",
          "trusted-sink",
          "no-file-no-failure",
        ].map((status) => [["report"], status] as const),
        [["report", "--throw"], "available"],
        [["report", "--wait-ms", "2000", "--deadline-ms", "100"], "available"],
        [["report", "--refuse"], "available"],
      ];
      const humanSide: unknown[] = [];
      const machineSide: unknown[] = [];
      for (const [argv, status] of variants) {
        const run = await human(argv, status);
        const twin = await machineTwin(argv, status);
        const variant = `${argv.join(" ")} ${status}`;
        humanSide.push({
          variant,
          code: run.code,
          cause: /\[([A-Z0-9_]+)\]$/mu.exec(run.stderr)?.[1] ?? null,
        });
        machineSide.push({
          variant,
          code: twin.code,
          cause: twin.code === 0 ? null : String(twin.result.causeCode),
        });
      }
      expect(humanSide).toEqual(machineSide);
    },
    timeout,
  );
  for (const [variant, argv, status, env] of [
    ["usage", ["report", "--bogus"], "available", {}],
    ["unknown", ["nope"], "available", {}],
    [
      "before-start",
      ["report", "--deadline-ms", "1000"],
      "available",
      { FX_CLOCK_JUMP_MS: "1000000" },
    ],
    ["denied", ["guarded"], "available", { FX_APPROVAL: "deny" }],
    ["preparation", ["guarded"], "available", { FX_APPROVAL: "attach-throws" }],
  ] as const)
    test(
      `KF6.d no-line-before-entry-or-without-status ${variant}`,
      async () => {
        const run = await human(argv, status, env);
        expect(run.code).not.toBe(0);
        expect(run.stdout).toBe("");
        expect(lineCount(run.stderr)).toBe(1);
        expect(run.stderr).not.toContain("Diagnostics:");
      },
      timeout,
    );
  for (const argv of [["--help"], ["--discover"]])
    test(
      `KF6.d no-line ${argv[0]}`,
      async () => {
        const run = await human(argv, "available");
        expect({ code: run.code, stderr: run.stderr }).toEqual({
          code: 0,
          stderr: "",
        });
        expect(run.stdout).not.toBe("");
        expect(run.stdout).not.toContain("Diagnostics:");
      },
      timeout,
    );
  test(
    "KF6.d no-line stop: SIGTERM during the handler prints nothing",
    async () => {
      const launched = await launch({
        script: statusCli,
        argv: ["report", "--wait-ms", "2000"],
        env: { FX_STATUS: "available" },
      });
      try {
        await launched.barrier("handler-entered");
        launched.signal("SIGTERM");
        const observed = await exitWithin(launched);
        expect(observed.code).toBe(143);
        expect(observed.stdout.byteLength + observed.stderr.byteLength).toBe(0);
      } finally {
        await release(launched);
      }
    },
    timeout,
  );
  test(
    "KF6.f human-line-no-file-no-failure",
    async () => {
      const run = await human(["report"], "no-file-no-failure");
      expect({ code: run.code, stderr: run.stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      expect(lastLine(run.stdout)).toBe("Diagnostics: no log file");
    },
    timeout,
  );
});
