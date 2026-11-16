// Component cases (O01.b, T03.b, Q01.b, B01 to B05) and supporting checks of
// the internal framing and scope seams. Component evidence never satisfies a
// process row; these bind what the process layer cannot reach directly.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import type {
  CauseTable,
  RecordedEffect,
} from "../../../starters/contract3/src/kernel/index.ts";
import { stateAddon } from "../../../starters/contract3/src/addons/state/index.ts";
import { fixtureQualification } from "../../../starters/contract3/src/addons/state/fixture.ts";
import {
  qualificationRows,
  resolveQualification,
} from "../../../starters/contract3/src/addons/state/qualification.ts";
import {
  encodeRecord,
  parseRecords,
} from "../../../starters/contract3/src/addons/state/framing.ts";
import {
  canonicalise,
  conflicts,
} from "../../../starters/contract3/src/addons/state/scope.ts";
import { caseTest, readFramed, readOperations } from "./harness.ts";

const causes = {
  DOMAIN_CX_LOCK_HELD: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_CX_UNRESOLVED: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };
const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;
const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const none = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const pendingStep = {
  kind: "command",
  command: "cx.pending",
  args: [],
} as const;
const coordinationHandoff = {
  handoff: {
    owner: "operator",
    reason: "Coordination refused.",
    inspect: [pendingStep],
  },
} as const;
const heldStation = station(allCauses, {
  ...words,
  commandIdentity: "cx.change",
  causeCode: "DOMAIN_CX_LOCK_HELD",
  trigger: "Coordination refused.",
  repairAction: "Inspect the unfinished report.",
  guidance: coordinationHandoff,
  independentObservable: "cx.change:held",
});
const unresolvedStation = station(allCauses, {
  ...words,
  commandIdentity: "cx.change",
  causeCode: "DOMAIN_CX_UNRESOLVED",
  trigger: "Coordination refused.",
  repairAction: "Inspect the unfinished report.",
  guidance: coordinationHandoff,
  independentObservable: "cx.change:unresolved",
});

type Scenario = (
  record: (
    operation: (recorded: RecordedEffect<"e.one" | "e.two">) => Promise<void>,
  ) => Promise<void>,
  host: {
    readonly root: string;
    readonly state: ReturnType<typeof stateAddon>;
  },
) => Promise<void>;

// One in-process host with one changing command whose handler runs a
// scenario inside a real admitted transaction.
async function inTransaction(scenario: Scenario): Promise<{
  readonly root: string;
  readonly state: ReturnType<typeof stateAddon>;
}> {
  const root = join(
    mkdtempSync(join(tmpdir(), "c3-state-component-")),
    "state",
  );
  const state = stateAddon({ root, report: "cx.pending" });
  const pending = command({
    identity: "cx.pending",
    route: ["pending"],
    summary: "Report unfinished work.",
    input: none,
    capabilities: {},
    stations: [
      station(allCauses, {
        ...words,
        commandIdentity: "cx.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Read.",
        repairAction: null,
        guidance: {
          next: { kind: "instruction", text: "Inspect listed cases." },
        },
        independentObservable: "cx.pending:read",
      }),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: "cx.pending", causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "Read.",
          data: null,
          effects: empty,
        },
      ),
  });
  const change = changing({
    identity: "cx.change",
    route: ["change"],
    summary: "Run one component scenario.",
    input: {
      ...none,
      arguments: [
        {
          name: "n",
          summary: "n",
          required: true,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 8,
            choices: null,
            pattern: null,
          },
        },
      ],
    },
    capabilities: {},
    effectClass: "repository-local",
    effects: ["e.one", "e.two"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_CX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_CX_UNRESOLVED",
    stations: [heldStation, unresolvedStation],
    run: async (_input, context) => {
      await state.transaction(
        context.state,
        {
          command: "cx.change",
          scope: { resources: [{ resource: "r", key: "component" }] },
        },
        async (transaction) => {
          await scenario(
            (operation) =>
              transaction.record(
                "e.one",
                (recorded) => operation(recorded),
                () => Promise.resolve(true),
              ),
            { root, state },
          );
        },
      );
      return context.result(
        { commandIdentity: "cx.change", causeCode: "DOMAIN_CX_LOCK_HELD" },
        {
          message: "Scenario finished.",
          data: null,
          effects: empty,
        },
      );
    },
  });
  const contract = contractFor({
    cli: "cx",
    commands: [change, pending],
    state: state.descriptor,
    causes,
    installedAddons: ["state"],
  });
  const executed = await contract.execute(
    "cx.change",
    ["x"],
    crypto.randomUUID(),
    {},
  );
  if (!executed.ok)
    throw new Error(
      `Component host failed: ${executed.path} ${executed.reason}`,
    );
  return { root, state };
}

function eventKinds(root: string): readonly string[] {
  const [operation] = readOperations(root);
  return operation ? operation.events.records.map((record) => record.kind) : [];
}

caseTest("B01.a-admit-start-active-effect", async () => {
  let recordedBeforeStart = false;
  const { root } = await inTransaction(async (record, host) => {
    await record(async (recorded) => {
      await recorded.admitStart(recorded.runId, recorded.effect, () => {
        // Independent reader: the durable delegate record precedes start.
        const [operation] = readOperations(host.root);
        recordedBeforeStart =
          operation?.events.records.at(-1)?.kind === "delegate-admitted";
        return Promise.resolve(0);
      });
    });
  });
  expect(recordedBeforeStart).toBe(true);
  expect(eventKinds(root)).toEqual([
    "effect-started",
    "delegate-admitted",
    "effect-confirmed",
    "outcome",
  ]);
  rmSync(join(root, ".."), { recursive: true, force: true });
});

caseTest("B02.a-admit-start-after-close-rejected", async () => {
  let retained: RecordedEffect<"e.one" | "e.two"> | undefined;
  let started = 0;
  let rejected = false;
  const { root } = await inTransaction(async (record) => {
    await record((recorded) => {
      retained = recorded;
      return Promise.resolve();
    });
    const handle = retained;
    if (!handle) throw new Error("No capability.");
    await handle
      .admitStart(handle.runId, handle.effect, () => {
        started += 1;
        return Promise.resolve(0);
      })
      .catch(() => {
        rejected = true;
      });
  });
  expect(rejected).toBe(true);
  expect(started).toBe(0);
  expect(eventKinds(root)).not.toContain("delegate-admitted");
  rmSync(join(root, ".."), { recursive: true, force: true });
});

caseTest("B03.a-admit-start-wrong-run-or-effect", async () => {
  let started = 0;
  const rejections: string[] = [];
  const { root } = await inTransaction(async (record) => {
    await record(async (recorded) => {
      const start = () => {
        started += 1;
        return Promise.resolve(0);
      };
      await recorded
        .admitStart("another-run", recorded.effect, start)
        .catch(() => rejections.push("run"));
      await recorded
        .admitStart(recorded.runId, "e.two", start)
        .catch(() => rejections.push("effect"));
    });
  });
  expect(rejections).toEqual(["run", "effect"]);
  expect(started).toBe(0);
  expect(eventKinds(root)).not.toContain("delegate-admitted");
  rmSync(join(root, ".."), { recursive: true, force: true });
});

caseTest("B04.a-emergency-record", async () => {
  let threw = false;
  const { root } = await inTransaction(async (record, host) => {
    await record((recorded) => {
      try {
        const facts = {
          runId: recorded.runId,
          commandIdentity: "cx.change",
          phase: "dispatched",
        } as const;
        host.state.emergencyRecord(facts);
        host.state.emergencyRecord(facts);
        host.state.emergencyRecord({
          runId: "unknown-run",
          commandIdentity: null,
          phase: "preparing",
        });
      } catch {
        threw = true;
      }
      return Promise.resolve();
    });
  });
  expect(threw).toBe(false);
  const emergencies = (readOperations(root)[0]?.events.records ?? []).filter(
    (entry) => entry.kind === "emergency",
  );
  expect(emergencies.map((entry) => entry.payload.phase)).toEqual([
    "dispatched",
  ]);
  rmSync(join(root, ".."), { recursive: true, force: true });
});

caseTest("B05.a-closing-waits-for-admitted-start", async () => {
  const order: string[] = [];
  let finish: (() => void) | undefined;
  let lateRejected = false;
  const { root } = await inTransaction(async (record) => {
    await record((recorded) => {
      void recorded.admitStart(recorded.runId, recorded.effect, async () => {
        order.push("start-begun");
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await recorded
          .admitStart(recorded.runId, recorded.effect, () => Promise.resolve(0))
          .catch(() => {
            lateRejected = true;
          });
        order.push("start-settled");
        return 0;
      });
      order.push("operation-returned");
      setTimeout(() => finish?.(), 20);
      return Promise.resolve();
    });
    order.push("record-returned");
  });
  expect(order).toEqual([
    "start-begun",
    "operation-returned",
    "start-settled",
    "record-returned",
  ]);
  expect(lateRejected).toBe(true);
  const kinds = eventKinds(root);
  expect(kinds.indexOf("delegate-admitted")).toBeLessThan(
    kinds.indexOf("effect-confirmed"),
  );
  rmSync(join(root, ".."), { recursive: true, force: true });
});

caseTest("O01.b-admission-rejects-missing-stations", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-state-o01b-"));
  const state = stateAddon({ root: join(root, "state"), report: "cx.pending" });
  const base = {
    identity: "cx.change",
    route: ["change"],
    summary: "Declaration check.",
    input: none,
    capabilities: {},
    effectClass: "repository-local",
    effects: ["e.one"],
    ifNoResult: state.descriptor.ifNoResult,
    run: () => Promise.reject(new Error("never run")),
  } as const;
  expect(() =>
    changing({
      ...base,
      heldLockCause: "DOMAIN_CX_LOCK_HELD",
      unresolvedCaseCause: "DOMAIN_CX_UNRESOLVED",
      stations: [unresolvedStation],
    }),
  ).toThrow();
  expect(() =>
    changing({
      ...base,
      heldLockCause: "DOMAIN_CX_LOCK_HELD",
      unresolvedCaseCause: "DOMAIN_CX_UNRESOLVED",
      stations: [heldStation],
    }),
  ).toThrow();
  expect(() =>
    changing({
      ...base,
      heldLockCause: "DOMAIN_CX_LOCK_HELD",
      unresolvedCaseCause: "DOMAIN_CX_LOCK_HELD",
      stations: [heldStation],
    }),
  ).toThrow();
  rmSync(root, { recursive: true, force: true });
  await Promise.resolve();
});

caseTest("T03.b-bad-bounds-rejected", async () => {
  const declare = (minimumMilliseconds: number, maximumMilliseconds: number) =>
    station(allCauses, {
      retryDelayPolicy: {
        kind: "bounded",
        minimumMilliseconds,
        maximumMilliseconds,
      },
      reachability: "required",
      unreachableRationale: null,
      commandIdentity: "cx.change",
      causeCode: "TRANSIENT_NOT_STARTED",
      trigger: "Temporary.",
      repairAction: "Retry after the delay.",
      guidance: { next: { kind: "retry" } },
      independentObservable: "cx.change:transient",
    });
  expect(() => declare(0, 10)).toThrow();
  expect(() => declare(-5, 10)).toThrow();
  expect(() => declare(20, 10)).toThrow();
  expect(() => declare(10, 10)).not.toThrow();
  await Promise.resolve();
});

caseTest("Q01.b-fixture-never-enables", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-state-q01b-"));
  const fixtureAddon = stateAddon({
    root: join(root, "a"),
    report: "cx.pending",
    qualification: fixtureQualification("q01b"),
  });
  const production = stateAddon({
    root: join(root, "b"),
    report: "cx.pending",
  });
  expect(fixtureAddon.capabilities().qualification).toBe("fixture:q01b");
  expect(production.capabilities().qualification).toBe("unqualified");
  expect(production.capabilities().stoppedOwnerProof).toBe("unavailable");
  for (const report of [
    fixtureAddon.capabilities(),
    production.capabilities(),
  ]) {
    expect(report.automaticReclaim).toBe("unavailable");
    expect(report.humanAssistedTakeover).toBe("unavailable");
    expect(report.humanOutcomeUnknownClosure).toBe("unavailable");
  }
  expect(qualificationRows).toEqual([]);
  // A look-alike object is not a registered fixture and qualifies nothing.
  expect(
    resolveQualification({
      label: "forged",
      stoppedOwner: "lease-and-no-delegate",
    }),
  ).toEqual({ label: "unqualified", stoppedOwner: "unavailable" });
  rmSync(root, { recursive: true, force: true });
  await Promise.resolve();
});

// ---- Supporting seam checks (not frozen cases) -----------------------------

test("framing: the add-on encoder and the test-owned reader agree", () => {
  const bytes = encodeRecord("intent", { operationId: "op-x", n: 1 });
  const ours = readFramed(bytes);
  expect(ours.records.map((record) => record.payload.operationId)).toEqual([
    "op-x",
  ]);
  const theirs = parseRecords(bytes);
  expect(theirs.ok && theirs.records.length).toBe(1);
});

test("framing: torn tails are not state; damage before more bytes is corrupt", () => {
  const one = encodeRecord("effect-started", { effect: "e" });
  const two = encodeRecord("completion", { completed: ["e"] });
  const joined = new Uint8Array([...one, ...two]);
  const torn = parseRecords(joined.subarray(0, joined.length - 3));
  expect(torn.ok && torn.tornTail && torn.records.length).toBe(1);
  const damaged = new Uint8Array(joined);
  damaged[one.length - 3] = (damaged[one.length - 3] ?? 0) ^ 1;
  expect(parseRecords(damaged).ok).toBe(false);
  expect(readFramed(damaged).corrupt).toBe(true);
});

test("scope: aliases share keys; distinct names and unknown scope behave", () => {
  const directory = mkdtempSync(join(tmpdir(), "c3-scope-"));
  writeFileSync(join(directory, "a"), "x");
  symlinkSync(join(directory, "a"), join(directory, "link"));
  const a = canonicalise({
    resources: [{ resource: "a", path: join(directory, "a") }],
  });
  const link = canonicalise({
    resources: [{ resource: "l", path: join(directory, "link") }],
  });
  const b = canonicalise({
    resources: [{ resource: "b", path: join(directory, "b") }],
  });
  const unknown = canonicalise({ unknown: true });
  expect(conflicts(a.keys, link.keys)).toBe(true);
  expect(conflicts(a.keys, b.keys)).toBe(false);
  expect(conflicts(a.keys, undefined)).toBe(true);
  expect(unknown.unknown).toBe(true);
  expect(canonicalise({ resources: [] }).unknown).toBe(true);
  expect(
    canonicalise({ resources: [{ resource: "r", path: "relative" }] }).unknown,
  ).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
