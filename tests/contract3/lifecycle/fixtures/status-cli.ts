// LABELLED TEST-ONLY FIXTURE CLI "st" for the kernel side of the diagnostics
// status seam (Part 3). Its status-reporting add-on is a throwaway stand-in,
// not the T5 diagnostics add-on: FX_STATUS selects what `freeze` does. Never
// registered as a production command; never ships.
import { appendFileSync } from "node:fs";
import {
  command,
  contractFor,
} from "../../../../starters/contract3/src/kernel/index.ts";
import type {
  DiagnosticsCapability,
  RunAddon,
} from "../../../../starters/contract3/src/kernel/index.ts";
import { programsAddon } from "../../../../starters/contract3/src/addons/programs/index.ts";
import { runProcessOn } from "../../../../starters/contract3/src/kernel/lifecycle.ts";
import { processHost } from "../../../../starters/contract3/src/kernel/process-host.ts";
import type { ProcessHost } from "../../../../starters/contract3/src/kernel/process-types.ts";
import {
  registerRuntime,
  runtimeOf,
} from "../../../../starters/contract3/src/kernel/runtime.ts";
import type { ContractRuntime } from "../../../../starters/contract3/src/kernel/runtime.ts";
import { path } from "../../../../starters/contract3/src/kernel/validation/brands.ts";

const ledgerPath = process.env.FX_LEDGER;
const mode = process.env.FX_STATUS ?? "available";
function ledger(line: string): void {
  if (ledgerPath) appendFileSync(ledgerPath, `${line}\n`);
}
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const availableStatus = {
  status: "available",
  file: "/private/state/st/diagnostics/run.log",
  sinkFailure: null,
  droppedRecords: 0,
  unflushedRecords: 0,
  truncatedRecords: 0,
  countsComplete: true,
  closed: true,
};
// Valid statuses of both variants (DIAG-2, DIAG-3) and one invalid one.
const statuses: Readonly<Record<string, unknown>> = {
  available: availableStatus,
  unavailable: {
    status: "unavailable",
    reason: "status-unavailable",
    trusted: { droppedRecords: 2, countsComplete: false },
  },
  // `file` must be absolute and the variant strict: two faults.
  invalid: {
    status: "available",
    file: "relative/run.log",
    sinkFailure: null,
    droppedRecords: 0,
    unflushedRecords: 0,
    truncatedRecords: 0,
    countsComplete: true,
    closed: true,
    secret: "FX-STATUS-PAYLOAD",
  },
};

// Seam review hostile statuses. `oversize` is valid but too large for the
// 16,384-byte fallback; `accessor` reads valid once and invalid after;
// `nonjson` is not plain JSON but serialises to a valid status.
function hostile(): unknown {
  if (mode === "oversize")
    return { ...availableStatus, file: `/${"a".repeat(16_000)}` };
  if (mode === "accessor") {
    let reads = 0;
    const base = { ...availableStatus };
    Object.defineProperty(base, "file", {
      enumerable: true,
      get: () => (reads++ === 0 ? "/private/run.log" : "relative/run.log"),
    });
    return base;
  }
  return { toJSON: () => availableStatus };
}

async function frozen(limit: number): Promise<unknown> {
  ledger(`freeze-start ${limit} ${Date.now()}`);
  switch (mode) {
    case "throws":
      throw new Error("FX-STATUS-PAYLOAD freeze failed");
    case "never":
      return new Promise(() => undefined);
    case "oversize":
    case "accessor":
    case "nonjson":
      return hostile();
    case "slow":
      // Within the 500 ms budget.
      await sleep(300);
      return statuses.available;
    default:
      // Modes that only change attach report the ordinary available status.
      return statuses[mode] ?? availableStatus;
  }
}

// The throwaway status-reporting add-on. Its attach is effect-free apart
// from the test ledger.
const statusAddon: RunAddon<DiagnosticsCapability> = {
  reportsStatus: true,
  attach(run) {
    ledger(`status-attach ${run.commandIdentity}`);
    if (mode === "attach-throws") throw new Error("Fixture attach fault.");
    const capability = {
      record: (event: string) => ledger(`record ${event}`),
    };
    // `bad-capability` offers no `record`, so the kernel refuses the
    // context before the handler (INTERNAL_PREPARATION).
    if (mode === "bad-capability") Reflect.deleteProperty(capability, "record");
    return {
      capability: Object.freeze(capability),
      settle(limit) {
        ledger(`status-settle ${limit ?? "none"}`);
        return Promise.resolve(true);
      },
      killNow: () => ledger("status-kill"),
      ...(mode === "no-freeze" ? {} : { freeze: frozen }),
    };
  },
};

const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const integer = <const Name extends string>(name: Name) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: false,
    repeatable: false,
    value: { kind: "integer", minimum: 1, maximum: 60_000 },
  }) as const;
const flag = <const Name extends string>(name: Name) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: false,
    repeatable: false,
    value: null,
  }) as const;
const input = {
  arguments: [],
  constraints: [],
  deadlineSupported: true,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const report = command({
  identity: "st.report",
  route: ["report"],
  summary: "Do fixture work that may be observed.",
  input: {
    ...input,
    options: [
      integer("--wait-ms"),
      flag("--record"),
      flag("--bad"),
      flag("--throw"),
      flag("--program"),
    ],
  },
  capabilities: { diagnostics: true, programs: true },
  run: async (options, context) => {
    ledger("handler-entered");
    if (options["--record"] === true) context.diagnostics.record("work", null);
    if (options["--program"] === true) {
      await context.programs.inspect({
        executable: path("/bin/sh"),
        args: ["-c", 'echo "program-done" >> "$FX_LEDGER"'],
        timeoutMilliseconds: 5_000,
        outputLimitBytes: 1024,
        shutdownMilliseconds: 500,
      });
    }
    const wait = options["--wait-ms"];
    if (wait !== undefined) await sleep(wait);
    if (options["--throw"] === true) throw new Error("FX handler fault");
    ledger("handler-done");
    return context.result(
      { commandIdentity: "st.report", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The fixture work finished.",
        data: { value: options["--bad"] === true ? Number.NaN : 1 },
        effects: empty,
      },
    );
  },
});

const plain = command({
  identity: "st.plain",
  route: ["plain"],
  summary: "Do fixture work without diagnostics.",
  input: { ...input, options: [] },
  capabilities: {},
  run: (_options, context) =>
    context.result(
      { commandIdentity: "st.plain", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The plain work finished.", data: null, effects: empty },
    ),
});

// Ledgers when the kernel has built (frozen) a result, so the order of
// "result-built" and "freeze-start" is observable (DIAG-14).
function observed(runtime: ContractRuntime): ContractRuntime {
  return {
    ...runtime,
    buildResult: async (result) => {
      const built = await runtime.buildResult(result);
      ledger("result-built");
      return built;
    },
    buildKernelStation: async (selected, facts, effects) => {
      const built = await runtime.buildKernelStation(selected, facts, effects);
      ledger("result-built");
      return built;
    },
  };
}

// P3-style clock jump for a deadline that passed before dispatch.
function host(real: ProcessHost): ProcessHost {
  let calls = 0;
  const jump = Number(process.env.FX_CLOCK_JUMP_MS ?? "0");
  return {
    ...real,
    now() {
      calls += 1;
      return jump > 0 && calls > 1 ? real.now() + jump : real.now();
    },
  };
}

// X-K5 (swarm triage): a non-conforming add-on whose settle throws
// synchronously instead of resolving.
function throwingSettle<C>(addon: RunAddon<C>): RunAddon<C> {
  return {
    attach(run) {
      const attached = addon.attach(run);
      return {
        ...attached,
        settle() {
          ledger("settle-throws");
          if (process.env.FX_SETTLE_THROWS === "async")
            return Promise.reject(new Error("Fixture settle rejection."));
          throw new Error("Fixture settle fault.");
        },
      };
    },
  };
}
const programs =
  process.env.FX_SETTLE_THROWS !== undefined
    ? throwingSettle(programsAddon())
    : programsAddon();

const contract = contractFor({
  cli: "st",
  commands: [report, plain],
  installedAddons: ["diagnostics", "programs"],
});
const runtime = runtimeOf(contract);
if (!runtime) throw new Error("Fixture contract has no runtime.");
const wrapped = {};
registerRuntime(wrapped, observed(runtime));
ledger(`front-door-start ${Date.now()}`);
await runProcessOn(
  wrapped,
  { addons: { diagnostics: statusAddon, programs } },
  () => host(processHost()),
)(process.argv.slice(2));
