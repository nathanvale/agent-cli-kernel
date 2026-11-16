// Component cases (O01.b, T03.b, Q01.b, B01 to B05) and supporting checks of
// the internal framing and scope seams. Component evidence never satisfies a
// process row; these bind what the process layer cannot reach directly.
import { afterEach, expect, test } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../starters/contract3/src/kernel/index.ts";
import type {
  ApprovalRuntime,
  AuthorityId,
  CauseTable,
  RecordedEffect,
  ResourceId,
} from "../../../starters/contract3/src/kernel/index.ts";
import { stateAddon } from "../../../starters/contract3/src/addons/state/index.ts";
import { stateAddonWithTestSeams } from "../../../starters/contract3/src/addons/state/fixture.ts";
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
import { caseTest, readFramed, readOperations, testFolder } from "./harness.ts";
import { coordinationExpected } from "./holder.ts";

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
// Every temporary root is removed after its test, pass or fail (N5).
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(prefix: string): string {
  const root = testFolder(prefix);
  temporaryRoots.push(root);
  return root;
}

type Approval = NonNullable<
  Parameters<ReturnType<typeof stateAddon>["transaction"]>[1]["approval"]
>;
type Outcome = Awaited<
  ReturnType<ReturnType<typeof stateAddon>["transaction"]>
>;

async function inTransaction(
  scenario: Scenario,
  approval?: (boundary: {
    readonly resource: (value: unknown) => ResourceId;
    readonly authority: (value: unknown) => AuthorityId;
  }) => Approval,
): Promise<{
  readonly root: string;
  readonly state: ReturnType<typeof stateAddon>;
  readonly outcome: Outcome | undefined;
}> {
  const root = join(temporaryRoot("c3-state-component-"), "state");
  let outcome: Outcome | undefined;
  const composed: {
    boundary?: {
      readonly resource: (value: unknown) => ResourceId;
      readonly authority: (value: unknown) => AuthorityId;
    };
  } = {};
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
      const boundary = composed.boundary;
      outcome = await state.transaction(
        context.state,
        {
          command: "cx.change",
          scope: { resources: [{ resource: "r", key: "component" }] },
          ...(approval && boundary ? { approval: approval(boundary) } : {}),
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
  composed.boundary = contract.boundary;
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
  return { root, state, outcome };
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
      // Release the in-flight start on the next event-loop turn, after the
      // record has marked the effect closing (event-loop order, not a timed
      // delay): closing must still wait for the start to settle.
      setImmediate(() => finish?.());
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
});

caseTest("O01.b-admission-rejects-missing-stations", async () => {
  const root = temporaryRoot("c3-state-o01b-");
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
  const root = temporaryRoot("c3-state-q01b-");
  try {
    const fixtureAddon = stateAddonWithTestSeams(
      { root: join(root, "a"), report: "cx.pending" },
      { fixtureLabel: "q01b" },
    );
    const production = stateAddon({
      root: join(root, "b"),
      report: "cx.pending",
    });
    // A fixture-enabled proof is reported fixture-only, never available.
    expect(fixtureAddon.capabilities().qualification).toBe("fixture:q01b");
    expect(fixtureAddon.capabilities().stoppedOwnerProof).toBe(
      coordinationExpected ? "fixture-only" : "unavailable",
    );
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
    expect(resolveQualification()).toEqual({
      label: "unqualified",
      source: "production",
      stoppedOwner: "unavailable",
    });
    // The production entry ignores a smuggled qualification or hook: it has
    // no such option, whatever an untyped caller passes.
    const smuggled = {
      root: join(root, "c"),
      report: "cx.pending",
      qualification: {
        label: "forged",
        source: "production",
        stoppedOwner: "lease-and-no-delegate",
      },
      phase: () => Promise.reject(new Error("never called")),
    };
    const forged = stateAddon(smuggled).capabilities();
    expect(forged.qualification).toBe("unqualified");
    expect(forged.stoppedOwnerProof).toBe("unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const directory = temporaryRoot("c3-scope-");
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

// ---- Repair round 1 controls -----------------------------------------------

// A rejection shaped as the approval add-on reports it; `consumed` decides
// whether the item was consumed (CMD-15). The state add-on reads it
// structurally and never imports the approval add-on.
class RejectionDouble extends Error {
  readonly consumed: boolean;
  constructor(consumed: boolean) {
    super("approval rejection double");
    this.consumed = consumed;
  }
}

caseTest("S05.a-approval-lost-versus-unavailable", async () => {
  const kinds: string[] = [];
  for (const consumed of [true, false]) {
    const runtime: ApprovalRuntime = {
      check: () => Promise.resolve(true),
      revalidateAndConsume: () => Promise.reject(new RejectionDouble(consumed)),
    };
    const { root, outcome } = await inTransaction(
      () => Promise.resolve(),
      (boundary) => ({
        runtime,
        request: {
          authority: boundary.authority("owner"),
          resource: boundary.resource("r"),
          resourceRevision: "observed",
          effects: ["e.one"],
          preview: "p1",
        },
      }),
    );
    kinds.push(outcome?.kind ?? "none");
    // Neither outcome publishes an intent or starts an effect.
    expect(readOperations(root)).toEqual([]);
  }
  expect(kinds).toEqual(["approval-lost", "approval-unavailable"]);
});

caseTest("B06.a-effect-recorded-once", async () => {
  let second = "not attempted";
  const { root } = await inTransaction(async (record) => {
    await record(() => Promise.resolve());
    await record(() => Promise.resolve()).then(
      () => {
        second = "recorded";
      },
      () => {
        second = "rejected";
      },
    );
  });
  expect(second).toBe("rejected");
  expect(eventKinds(root).filter((kind) => kind === "effect-started")).toEqual([
    "effect-started",
  ]);
});
