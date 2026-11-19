import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../kernel/src/kernel/index.ts";
import type {
  ApprovalRuntime,
  AuthorityId,
  CauseTable,
  EffectTransaction,
  RecordedEffect,
  ResourceId,
  StateCapability,
} from "../../../kernel/src/kernel/index.ts";
import { stateAddon } from "../../../kernel/src/addons/state/index.ts";
import type {
  Observer,
  PublishedOperation,
} from "../../../kernel/src/addons/state/index.ts";
import { stateAddonWithTestSeams } from "../../../kernel/src/addons/state/fixture.ts";
import {
  errorCode,
  resolveCoordination,
} from "../../../kernel/src/addons/state/coordination.ts";
import {
  capabilityQualificationTable,
  movedStateRoot,
} from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import type { CapabilityQualificationRow } from "../../../kernel/src/addons/state/capability-qualification-table.ts";
import {
  bootIdentitySource,
  candidateQualification,
  machineBootIdentity,
  majorReleaseOf,
  resolveQualification,
} from "../../../kernel/src/addons/state/qualification.ts";
import type { FactOverrides } from "../../../kernel/src/addons/state/qualification.ts";
import {
  encodeRecord,
  parseRecords,
} from "../../../kernel/src/addons/state/framing.ts";
import {
  appendDelegateStart,
  appendEvent,
  delegateBoot,
  layout,
  readCase,
} from "../../../kernel/src/addons/state/store.ts";
import { stoppedOwnerProblem } from "../../../kernel/src/addons/state/install.ts";
import {
  canonicalise,
  conflicts,
} from "../../../kernel/src/addons/state/scope.ts";
import { checkedFlock } from "../../../kernel/src/addons/state/linux-flock.ts";
import { testFolder } from "../../support/test-folder.ts";
import {
  caseTest,
  framed,
  machineBootIdentityRead,
  noAppendAfterDamage,
  readFramed,
  readOperations,
  supportingTest,
  versionTwoStore,
  writeSyntheticOperation,
} from "./harness.ts";
import { coordinationExpected, lockFree } from "./holder.ts";
import { turns } from "../lifecycle/recording-host.ts";

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
    readonly published: PublishedOperation;
    readonly transaction: EffectTransaction<"e.one" | "e.two">;
  },
) => Promise<void>;

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
  options: {
    readonly root?: string;
    readonly keys?: readonly string[];
    readonly observers?: Readonly<Record<string, Observer>>;
    readonly build?: (options: {
      readonly root: string;
      readonly report: string;
    }) => ReturnType<typeof stateAddon>;
  } = {},
): Promise<{
  readonly root: string;
  readonly state: ReturnType<typeof stateAddon>;
  readonly outcome: Outcome | undefined;
}> {
  const root =
    options.root ?? join(temporaryRoot("c3-state-component-"), "state");
  let outcome: Outcome | undefined;
  const composed: {
    boundary?: {
      readonly resource: (value: unknown) => ResourceId;
      readonly authority: (value: unknown) => AuthorityId;
    };
  } = {};
  const state = options.build
    ? options.build({ root, report: "cx.pending" })
    : stateAddon({
        root,
        report: "cx.pending",
        observers: options.observers ?? {},
      });
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
      const declaration = {
        command: "cx.change",
        scope: {
          resources: options.keys
            ? options.keys.map((key) => ({ resource: `r-${key}`, key }))
            : [{ resource: "r", key: "component" }],
        },
      };
      outcome = await state.transaction(
        context.state,
        approval && boundary
          ? { ...declaration, approval: approval(boundary) }
          : declaration,
        async (transaction, published) => {
          await scenario(
            (operation) =>
              transaction.record(
                "e.one",
                (recorded) => operation(recorded),
                () => Promise.resolve(true),
              ),
            { root, state, published, transaction },
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

supportingTest(
  "CMD-11 supporting: work holds the published operation identity before any effect starts",
  async () => {
    let held = "";
    let publishedWhenHeld: readonly string[] = [];
    let journalWhenHeld: readonly string[] = ["unread"];
    const { root } = await inTransaction(async (record, host) => {
      held = host.published.operationId;
      publishedWhenHeld = readOperations(host.root).map((entry) => entry.id);
      journalWhenHeld = eventKinds(host.root);
      await record(() => Promise.resolve());
    });
    const [operation, ...rest] = readOperations(root);
    expect(rest).toEqual([]);
    if (!operation) throw new Error("No operation.");
    expect(held).toBe(operation.id);
    expect(publishedWhenHeld).toEqual([operation.id]);
    expect(journalWhenHeld).toEqual([]);
  },
);

supportingTest(
  "CMD-11 supporting: an Observer finds the label a handler wrote with its operation identity",
  async () => {
    const labels = new Set<string>();
    const observers: Readonly<Record<string, Observer>> = {
      "e.one": ({ operationId }) =>
        Promise.resolve(labels.has(operationId) ? "present" : "absent"),
    };
    const classOf = async (host: {
      readonly root: string;
      readonly state: ReturnType<typeof stateAddon>;
    }) => {
      const [operation, ...rest] = readOperations(host.root);
      expect(rest).toEqual([]);
      if (!operation) throw new Error("No operation.");
      const found = await host.state.history(operation.id);
      if (!found.ok) throw new Error(`History refused: ${found.reason}`);
      return found.history.observed["e.one"];
    };
    const labelled = await inTransaction(
      async (record, host) => {
        await record(() => {
          labels.add(host.published.operationId);
          return Promise.resolve();
        });
      },
      undefined,
      { observers },
    );
    expect(await classOf(labelled)).toBe("completed");
    const unlabelled = await inTransaction(
      async (record) => {
        await record(() => Promise.resolve());
      },
      undefined,
      { observers },
    );
    expect(await classOf(unlabelled)).toBe("uncertain");
  },
);

test("work is refused when the state add-on published no operation for it", async () => {
  const state = stateAddon({
    root: join(temporaryRoot("c3-state-component-"), "state"),
    report: "cx.pending",
  });
  let ran = false;
  const forged: StateCapability<"e.one"> = {
    transaction: (work) =>
      work({
        record: () => Promise.reject(new Error("Forged transaction.")),
      }).then(() => {
        throw new Error("Forged capability.");
      }),
  };
  const refused: unknown = await state
    .transaction(
      forged,
      {
        command: "cx.change",
        scope: { resources: [{ resource: "r", key: "component" }] },
      },
      () => {
        ran = true;
        return Promise.resolve();
      },
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(refused instanceof Error ? refused.message : refused).toBe(
    "Work runs only after the state add-on publishes its operation.",
  );
  expect(ran).toBe(false);
});

caseTest("B01.a-admit-start-active-effect", async () => {
  let recordedBeforeStart = false;
  const { root } = await inTransaction(async (record, host) => {
    await record(async (recorded) => {
      await recorded.admitStart(recorded.runId, recorded.effect, () => {
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
          phase: "handler-entered",
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
    "handler-entered",
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
    expect(capabilityQualificationTable).toEqual([]);
    expect(Object.isFrozen(capabilityQualificationTable)).toBe(true);
    const qualification = resolveQualification();
    expect(qualification.source).toBe("production");
    const store = join(root, "b");
    for (const folder of ["coordination", "operations", "settled", "staging"])
      mkdirSync(join(store, folder), { recursive: true });
    const unmatched = qualification.match(store, "any route");
    expect(unmatched.matched).toBe(false);
    const detail = unmatched.matched ? "" : unmatched.detail;
    expect(detail).not.toContain("state root's device");
    expect(detail).toEndWith("; qualified: no capability qualification row");
    const smuggled = {
      root: join(root, "c"),
      report: "cx.pending",
      qualification: {
        source: "production",
        match: () => ({ matched: true, label: "forged" }),
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

const candidateRow: CapabilityQualificationRow = {
  id: "candidate",
  os: process.platform,
  majorRelease: "7",
  observedRelease: "7.2.12-orbstack-00394-gbecdd6130068",
  filesystem: { name: "btrfs", type: 0x9123683e },
  primitive: "test route",
  bootIdentitySource: "/proc/sys/kernel/random/boot_id",
  processIdentity: "boot identity only",
  namespace: "test entry",
  delegatedWriters: "none",
  failureCases: [movedStateRoot],
  evidence: {
    record: "none",
    review: { session: "none", countersignature: "none", date: "none" },
  },
};

test("X27 supporting: in process, a candidate row names the one field that differs", () => {
  const root = temporaryRoot("c3-state-x27-");
  try {
    for (const folder of ["coordination", "operations", "settled", "staging"])
      mkdirSync(join(root, folder));
    const row = candidateRow;
    const readable: FactOverrides = {
      release: "7.9.0",
      filesystem: 0x9123683e,
      bootIdentity: "boot-one",
    };
    const match = (
      changes: Partial<CapabilityQualificationRow>,
      overrides: FactOverrides,
    ) =>
      candidateQualification(
        "x27",
        { ...row, ...changes },
        { ...readable, ...overrides },
      ).match(root, "test route");
    expect(match({}, {})).toEqual({
      matched: true,
      label: "fixture:x27",
      bootIdentity: "boot-one",
    });
    const cases: readonly (readonly [
      Partial<CapabilityQualificationRow>,
      FactOverrides,
      string,
    ])[] = [
      [{ os: "aix" }, {}, "): differs in os"],
      [{}, { release: "8.0.0" }, "): differs in major release"],
      [
        { filesystem: { name: "nfs", type: 0x6969 } },
        {},
        "): differs in filesystem",
      ],
      [{ primitive: "another route" }, {}, "): differs in coordination route"],
      [{}, { bootIdentity: null }, "): differs in boot identity"],
      [
        {},
        { devices: { settled: lstatSync(root).dev + 1 } },
        "; not on the state root's device: settled/; qualified: candidate (",
      ],
    ];
    for (const [changes, overrides, expected] of cases) {
      const result = match(changes, overrides);
      expect(result.matched).toBe(false);
      expect(result.matched ? "" : result.detail).toContain(expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("X27 supporting: the exported boot identity source and major release rule are the ones the matcher uses", () => {
  const root = temporaryRoot("c3-state-x27-exported-");
  try {
    for (const folder of ["coordination", "operations", "settled", "staging"])
      mkdirSync(join(root, folder));
    expect(bootIdentitySource).toBe("/proc/sys/kernel/random/boot_id");
    for (const [release, major] of [
      ["7.2.12-orbstack-00394-gbecdd6130068", "7"],
      ["6.8.0-1017-azure", "6"],
      ["25.6.0", "25"],
      ["70", "70"],
    ] as const) {
      expect(majorReleaseOf(release)).toBe(major);
      const row: CapabilityQualificationRow = {
        id: "candidate",
        os: process.platform,
        majorRelease: majorReleaseOf(release),
        observedRelease: release,
        filesystem: { name: "btrfs", type: 0x9123683e },
        primitive: "test route",
        bootIdentitySource,
        processIdentity: "boot identity only",
        namespace: "test entry",
        delegatedWriters: "none",
        failureCases: [movedStateRoot],
        evidence: {
          record: "none",
          review: { session: "none", countersignature: "none", date: "none" },
        },
      };
      const facts: FactOverrides = {
        release,
        filesystem: 0x9123683e,
        bootIdentity: "boot-one",
      };
      expect(
        candidateQualification("x27", row, facts).match(root, "test route"),
      ).toEqual({
        matched: true,
        label: "fixture:x27",
        bootIdentity: "boot-one",
      });
      const other = candidateQualification(
        "x27",
        { ...row, majorRelease: `${major}0` },
        facts,
      ).match(root, "test route");
      expect(other.matched ? "" : other.detail).toEndWith(
        "): differs in major release",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

const machineArm =
  machineBootIdentityRead() === undefined
    ? `none, as on this machine (${process.platform})`
    : `the machine's (${process.platform})`;

test(`X28 supporting: in process, the boot identity honours a test entry's override, reads as undefined when unreadable or empty, and reads ${machineArm} otherwise`, () => {
  const boot = (bootIdentity: string | null) =>
    candidateQualification("x28", candidateRow, {
      bootIdentity,
    }).bootIdentity();
  expect(boot("boot-one")).toBe("boot-one");
  expect(boot(null)).toBeUndefined();
  expect(boot("")).toBeUndefined();
  const machine = machineBootIdentityRead();
  expect(resolveQualification().bootIdentity()).toBe(machine);
  expect(machineBootIdentity()).toBe(machine);
  const bootOf = (payload: Readonly<Record<string, unknown>>) =>
    delegateBoot({ kind: "delegate-admitted", effect: "e", payload });
  expect(bootOf({ effect: "e", boot: "boot-one" })).toBe("boot-one");
  for (const payload of [{ effect: "e" }, { boot: "" }, { boot: 7 }])
    expect(bootOf(payload)).toBeUndefined();
  expect(
    delegateBoot({
      kind: "effect-started",
      effect: "e",
      payload: { boot: "x" },
    }),
  ).toBeUndefined();
});

test("X28 supporting: in process, appendDelegateStart writes boot only when there is one", () => {
  const path = join(temporaryRoot("c3-state-delegate-"), "events");
  writeFileSync(path, "");
  appendDelegateStart(path, "e", "boot-one");
  appendDelegateStart(path, "e", undefined);
  expect(
    readFramed(readFileSync(path)).records.map((record) => record.payload),
  ).toEqual([
    { effect: "e", boot: "boot-one", format: 1, kind: "delegate-admitted" },
    { effect: "e", format: 1, kind: "delegate-admitted" },
  ]);
});

test("K11.g supporting: in process, appendEvent appends after a whole record and refuses after torn or corrupt bytes", () => {
  const path = join(temporaryRoot("c3-state-append-"), "events");
  writeFileSync(path, "");
  appendEvent(path, "effect-started", { effect: "e" });
  appendEvent(path, "effect-confirmed", { effect: "e" });
  const whole = readFileSync(path);
  expect(readFramed(whole).records.map((record) => record.kind)).toEqual([
    "effect-started",
    "effect-confirmed",
  ]);
  const later = framed("completion", { completed: ["e"] });
  for (const tail of [
    later.slice(0, 1),
    later.slice(0, 30),
    later.slice(0, later.indexOf("\n") + 1),
    later.slice(0, -1),
    `${later.slice(0, 30)}\n${later}`,
  ]) {
    writeFileSync(path, Buffer.concat([whole, Buffer.from(tail)]));
    const before = readFileSync(path);
    expect(() => {
      appendEvent(path, "delegate-admitted", { effect: "e", boot: "b" });
    }).toThrow(noAppendAfterDamage);
    expect(readFileSync(path)).toEqual(before);
  }
});

test("K11.f supporting: in process, the stopped-owner rule refuses journal-torn at every cut of a record followed by a complete record that reads as torn, and passes every lone torn tail", () => {
  const root = temporaryRoot("c3-state-cuts-");
  versionTwoStore(root);
  const id = writeSyntheticOperation(root, join(root, "note"));
  const events = join(root, "operations", id, "events");
  const paths = layout(root);
  const started = framed("effect-started", { effect: "note.write" });
  const hidden = framed("delegate-admitted", {
    effect: "note.write",
    boot: "boot-one",
  });
  const lookalike = framed("effect-confirmed", {
    effect: "note.write",
    note: `C3S1 effect-started 0000000010 ${"a".repeat(64)}`,
  });
  const read = (text: string) => {
    writeFileSync(events, text);
    const found = readCase(paths, id);
    if (found === "not-found" || found === "unreadable")
      throw new Error(`The case read as ${found}.`);
    return found;
  };
  let hiddenCuts = 0;
  let corruptCuts = 0;
  let loneCuts = 0;
  for (const victim of [hidden, started, lookalike])
    for (let cut = 1; cut < victim.length; cut += 1) {
      const merged = read(`${started}${victim.slice(0, cut)}${hidden}`);
      if (merged === "corrupt") corruptCuts += 1;
      else {
        expect(merged.tornTail).toBe(true);
        expect(stoppedOwnerProblem(merged, "boot-two")).toBe("journal-torn");
        hiddenCuts += 1;
      }
      const lone = read(`${started}${lookalike}${victim.slice(0, cut)}`);
      if (lone === "corrupt") throw new Error(`Cut ${String(cut)} is corrupt.`);
      expect(lone.tornTail).toBe(true);
      expect(stoppedOwnerProblem(lone, "boot-two")).toBeUndefined();
      loneCuts += 1;
    }
  const lengths = hidden.length + started.length + lookalike.length - 3;
  expect(loneCuts).toBe(lengths);
  expect(corruptCuts).toBe(3);
  expect(hiddenCuts).toBe(lengths - 3);
  const whole = read(`${started}${lookalike}`);
  if (whole === "corrupt") throw new Error("A whole journal read as corrupt.");
  expect(whole.tornTail).toBe(false);
  expect(stoppedOwnerProblem(whole, "boot-two")).toBeUndefined();
});

test("K11.a supporting: in process, a delegate start refuses on the same boot, on a missing boot, and when the current boot cannot be read", () => {
  const root = temporaryRoot("c3-state-boots-");
  versionTwoStore(root);
  const id = writeSyntheticOperation(root, join(root, "note"));
  const paths = layout(root);
  writeFileSync(
    join(root, "operations", id, "events"),
    `${framed("effect-started", { effect: "note.write" })}${framed("delegate-admitted", { effect: "note.write", boot: "boot-one" })}`,
  );
  const target = readCase(paths, id);
  if (typeof target === "string")
    throw new Error(`The case read as ${target}.`);
  expect(stoppedOwnerProblem(target, "boot-two")).toBeUndefined();
  expect(stoppedOwnerProblem(target, "boot-one")).toBe("delegate-recorded");
  expect(stoppedOwnerProblem(target, undefined)).toBe("delegate-recorded");
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

const expectedEndedRefusal = {
  record:
    "The transaction ended when its work function returned or threw, so record refuses. Await every record inside the work function.",
  admitStart:
    "The transaction ended when its work function returned or threw, so admitStart refuses. Await every record inside the work function.",
} as const;

function eventLines(root: string): readonly string[] {
  const [operation] = readOperations(root);
  return operation
    ? operation.events.records.map((record) =>
        typeof record.payload.effect === "string"
          ? `${record.kind} ${record.payload.effect}`
          : record.kind,
      )
    : [];
}

function coordinationNow(root: string): {
  readonly journal: readonly string[];
  readonly leaseHeld: boolean;
  readonly keyLocksHeld: readonly boolean[];
} {
  const [operation] = readOperations(root);
  if (!operation) throw new Error("No operation.");
  const coordination = join(root, "coordination");
  return {
    journal: eventLines(root),
    leaseHeld: !lockFree(join(root, "operations", operation.id, "owner.lease")),
    keyLocksHeld: readdirSync(coordination)
      .filter((name) => name.startsWith("k-"))
      .map((name) => !lockFree(join(coordination, name))),
  };
}

function refusalOf(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => "not refused",
    (error: unknown) => (error instanceof Error ? error.message : "no message"),
  );
}

const readBackTrue = () => Promise.resolve(true);

const endedTurnLimit = 100;

async function untilEnded(
  transaction: EffectTransaction<"e.one" | "e.two">,
  startedEffect: "e.one" | "e.two",
): Promise<string> {
  const probeOperation = () =>
    Promise.reject(new Error("A probe record ran its operation."));
  let refusal = "not probed";
  for (let turn = 0; turn < endedTurnLimit; turn++) {
    refusal = await refusalOf(
      transaction.record(startedEffect, probeOperation, readBackTrue),
    );
    if (refusal === expectedEndedRefusal.record) break;
    await turns(1);
  }
  return refusal;
}

async function pendingRecordSettlesBeforeTheFinalEvent(): Promise<void> {
  const workReturned = Promise.withResolvers<void>();
  let ended = "not waited";
  let whileOperationRan: ReturnType<typeof coordinationNow> | undefined;
  let whileReadBackRan: ReturnType<typeof coordinationNow> | undefined;
  const { root, outcome } = await inTransaction((_record, host) => {
    void host.transaction.record(
      "e.one",
      async () => {
        await workReturned.promise;
        ended = await untilEnded(host.transaction, "e.one");
        whileOperationRan = coordinationNow(host.root);
      },
      () => {
        whileReadBackRan = coordinationNow(host.root);
        return Promise.resolve(true);
      },
    );
    workReturned.resolve();
    return Promise.resolve();
  });
  const stillOwned = {
    journal: ["effect-started e.one"],
    leaseHeld: true,
    keyLocksHeld: [true],
  };
  expect(ended).toBe(expectedEndedRefusal.record);
  expect(whileOperationRan).toEqual(stillOwned);
  expect(whileReadBackRan).toEqual(stillOwned);
  expect(coordinationNow(root)).toEqual({
    journal: ["effect-started e.one", "effect-confirmed e.one", "outcome"],
    leaseHeld: false,
    keyLocksHeld: [false],
  });
  expect(outcome?.kind === "ran" ? outcome.workFailed : undefined).toBe(false);
  expect(outcome?.proof.transactionState).toBe("partially-completed");
  expect(outcome?.proof.effects).toEqual({
    completed: ["e.one"],
    remaining: ["e.two"],
    uncertain: [],
    inventoryComplete: true,
  });
}

async function recordStillRunningWhenWorkThrowsSettlesFirst(): Promise<void> {
  const workThrew = Promise.withResolvers<void>();
  let ended = "not waited";
  let whileSurvivorRan: ReturnType<typeof coordinationNow> | undefined;
  const { root, outcome } = await inTransaction(async (_record, host) => {
    try {
      await Promise.all([
        host.transaction.record(
          "e.one",
          () => Promise.reject(new Error("The first effect failed.")),
          readBackTrue,
        ),
        host.transaction.record(
          "e.two",
          async () => {
            await workThrew.promise;
            ended = await untilEnded(host.transaction, "e.two");
            whileSurvivorRan = coordinationNow(host.root);
          },
          readBackTrue,
        ),
      ]);
    } finally {
      workThrew.resolve();
    }
  });
  const beforeTheSurvivorSettled = [
    "effect-started e.one",
    "effect-started e.two",
    "effect-unconfirmed e.one",
  ];
  expect(ended).toBe(expectedEndedRefusal.record);
  expect(whileSurvivorRan).toEqual({
    journal: beforeTheSurvivorSettled,
    leaseHeld: true,
    keyLocksHeld: [true],
  });
  expect(coordinationNow(root)).toEqual({
    journal: [...beforeTheSurvivorSettled, "effect-confirmed e.two", "outcome"],
    leaseHeld: false,
    keyLocksHeld: [false],
  });
  expect(outcome?.kind === "ran" ? outcome.workFailed : undefined).toBe(true);
  expect(outcome?.proof.transactionState).toBe("unknown");
  expect(outcome?.proof.effects).toEqual({
    completed: ["e.two"],
    remaining: [],
    uncertain: ["e.one"],
    inventoryComplete: true,
  });
}

async function callsAfterWorkReturnedAreRefused(): Promise<void> {
  const workReturned = Promise.withResolvers<void>();
  let lateCalls = 0;
  const late = () => {
    lateCalls += 1;
    return Promise.resolve();
  };
  let ended = "not waited";
  const whileWaiting = { record: "not called", admitStart: "not called" };
  let retained: EffectTransaction<"e.one" | "e.two"> | undefined;
  const { root } = await inTransaction((_record, host) => {
    retained = host.transaction;
    void host.transaction.record(
      "e.one",
      async (recorded) => {
        await workReturned.promise;
        ended = await untilEnded(host.transaction, "e.one");
        whileWaiting.record = await refusalOf(
          host.transaction.record("e.two", late, readBackTrue),
        );
        whileWaiting.admitStart = await refusalOf(
          recorded.admitStart(recorded.runId, recorded.effect, late),
        );
      },
      readBackTrue,
    );
    workReturned.resolve();
    return Promise.resolve();
  });
  expect(ended).toBe(expectedEndedRefusal.record);
  expect(whileWaiting).toEqual(expectedEndedRefusal);
  if (!retained) throw new Error("No transaction.");
  expect(await refusalOf(retained.record("e.two", late, readBackTrue))).toBe(
    expectedEndedRefusal.record,
  );
  expect(lateCalls).toBe(0);
  expect(eventLines(root)).toEqual([
    "effect-started e.one",
    "effect-confirmed e.one",
    "outcome",
  ]);
}

async function failedFinalAppendLeavesTheTransactionEnded(): Promise<void> {
  let retained: EffectTransaction<"e.one" | "e.two"> | undefined;
  let events = "";
  let appendRefused = "not tried";
  const { outcome } = await inTransaction((_record, host) => {
    retained = host.transaction;
    events = join(
      host.root,
      "operations",
      host.published.operationId,
      "events",
    );
    renameSync(events, `${events}.aside`);
    mkdirSync(events);
    appendRefused = appendOpenCode(events);
    return Promise.resolve();
  });
  expect(appendRefused).toBe("EISDIR");
  expect(readdirSync(events)).toEqual([]);
  expect(outcome?.kind).toBe("ran");
  rmdirSync(events);
  renameSync(`${events}.aside`, events);
  expect(readFileSync(events).byteLength).toBe(0);
  let lateCalls = 0;
  if (!retained) throw new Error("No transaction.");
  expect(
    await refusalOf(
      retained.record(
        "e.one",
        () => {
          lateCalls += 1;
          return Promise.resolve();
        },
        readBackTrue,
      ),
    ),
  ).toBe(expectedEndedRefusal.record);
  expect(lateCalls).toBe(0);
  expect(readFileSync(events).byteLength).toBe(0);
}

function appendOpenCode(path: string): string {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_APPEND));
    return "opened";
  } catch (error) {
    return errorCode(error);
  }
}

caseTest("K11.e-transaction-waits-for-started-effects", async () => {
  await pendingRecordSettlesBeforeTheFinalEvent();
  await recordStillRunningWhenWorkThrowsSettlesFirst();
  await callsAfterWorkReturnedAreRefused();
  await failedFinalAppendLeavesTheTransactionEnded();
});

supportingTest(
  "X13 supporting: the final event is appended, then the key coordination locks are released, then the lease last",
  async () => {
    const route = resolveCoordination();
    if (!route.available) throw new Error("No coordination route.");
    const releases: { name: string; finalEventAppended: boolean }[] = [];
    const { root } = await inTransaction(
      async (record) => {
        await record(() => Promise.resolve());
      },
      undefined,
      {
        keys: ["k1", "k2"],
        build: (options) =>
          stateAddonWithTestSeams(options, {
            coordination: {
              ...route,
              tryLock(path, create) {
                const attempt = route.tryLock(path, create);
                if (attempt.kind !== "held") return attempt;
                let held = true;
                return {
                  kind: "held",
                  release() {
                    if (held)
                      releases.push({
                        name: basename(path),
                        finalEventAppended:
                          eventLines(options.root).at(-1) === "outcome",
                      });
                    held = false;
                    attempt.release();
                  },
                };
              },
            },
          }),
      },
    );
    const keyLocks = readdirSync(join(root, "coordination")).filter((name) =>
      name.startsWith("k-"),
    );
    expect(keyLocks.length).toBe(2);
    expect(releases.map((release) => release.finalEventAppended)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(releases.at(0)?.name).toBe("admission.lock");
    expect(
      releases
        .slice(1, 3)
        .map((release) => release.name)
        .sort(),
    ).toEqual(keyLocks.sort());
    expect(releases.at(3)?.name).toBe("owner.lease");
  },
);

caseTest("L07.g-failed-move-keeps-outcome", async () => {
  const recordBoth: Scenario = async (record, host) => {
    await record(() => Promise.resolve());
    await host.transaction.record(
      "e.two",
      () => Promise.resolve(),
      () => Promise.resolve(true),
    );
  };
  const first = await inTransaction(recordBoth, undefined, { keys: ["k1"] });
  expect(first.outcome?.kind).toBe("ran");
  const root = first.root;
  const [settledCase, ...others] = readOperations(root);
  expect(others).toEqual([]);
  if (!settledCase) throw new Error("No case.");
  const settled = join(root, "settled");
  chmodSync(settled, 0o500);
  let admissionFree = false;
  let second: Awaited<ReturnType<typeof inTransaction>>;
  try {
    second = await inTransaction(
      async (record, host) => {
        admissionFree = lockFree(
          join(host.root, "coordination", "admission.lock"),
        );
        await recordBoth(record, host);
      },
      undefined,
      { keys: ["k2"], root },
    );
  } finally {
    chmodSync(settled, 0o700);
  }
  expect(second.outcome?.kind).toBe("ran");
  expect(
    second.outcome?.kind === "ran" ? second.outcome.workFailed : true,
  ).toBe(false);
  expect(admissionFree).toBe(true);
  expect(readdirSync(settled)).toEqual([]);
  const operations = readOperations(root);
  expect(operations.map((entry) => entry.id)).toContain(settledCase.id);
  for (const entry of operations)
    expect(entry.events.records.map((record) => record.kind)).toEqual([
      "effect-started",
      "effect-confirmed",
      "effect-started",
      "effect-confirmed",
      "completion",
    ]);
  const third = await inTransaction(recordBoth, undefined, {
    keys: ["k3"],
    root,
  });
  expect(third.outcome?.kind).toBe("ran");
  expect(readOperations(root, "settled").map((entry) => entry.id)).toEqual(
    operations.map((entry) => entry.id).sort(),
  );
});

supportingTest(
  "X24 supporting: a mover report that throws leaves the published transaction to run and release",
  async () => {
    const { root, outcome } = await inTransaction(
      async (record) => {
        await record(() => Promise.resolve());
      },
      undefined,
      {
        build: (options) =>
          stateAddonWithTestSeams(options, {
            moverReport: () => {
              throw new Error("The mover report failed.");
            },
          }),
      },
    );
    expect(outcome?.kind).toBe("ran");
    const [operation] = readOperations(root);
    if (!operation) throw new Error("No operation.");
    expect(operation.events.records.at(-1)?.kind).toBe("outcome");
    expect(lockFree(join(root, "coordination", "admission.lock"))).toBe(true);
    expect(
      lockFree(join(root, "operations", operation.id, "owner.lease")),
    ).toBe(true);
  },
);

supportingTest(
  "X23 supporting: an upgrade that fails after staging removes its staged format record",
  async () => {
    const { root, outcome } = await inTransaction(
      async (record) => {
        await record(() => Promise.resolve());
      },
      undefined,
      {
        build: (options) =>
          stateAddonWithTestSeams(options, {
            phase: (name) =>
              name === "upgrade-staged"
                ? Promise.reject(new Error("The staged upgrade failed."))
                : Promise.resolve(),
          }),
      },
    );
    expect(outcome?.kind === "unavailable" ? outcome.reason : "").toBe(
      "store-upgrade",
    );
    expect(readdirSync(join(root, "staging"))).toEqual([]);
    const format = readFramed(readFileSync(join(root, "format")));
    expect(format.records[0]?.payload.journal).toBe("contract3.state");
    expect(readOperations(root)).toEqual([]);
  },
);

supportingTest(
  "X23 supporting: a failure after the format rename says the format was replaced",
  async () => {
    const recordOne: Scenario = async (record) => {
      await record(() => Promise.resolve());
    };
    const { root, outcome } = await inTransaction(recordOne, undefined, {
      build: (options) =>
        stateAddonWithTestSeams(options, {
          phase: (name) =>
            name === "upgraded"
              ? Promise.reject(new Error("The upgrade was not confirmed."))
              : Promise.resolve(),
        }),
    });
    expect(outcome?.kind === "unavailable" ? outcome.reason : "").toBe(
      "store-upgrade-unconfirmed",
    );
    const format = readFramed(readFileSync(join(root, "format")));
    expect(format.records[0]?.payload.journal).toBe("contract3.state.2");
    expect(readOperations(root)).toEqual([]);
    const next = await inTransaction(recordOne, undefined, { root });
    expect(next.outcome?.kind).toBe("ran");
  },
);

caseTest("C01.j-failure-after-admission-releases-everything", async () => {
  const keys = ["k1", "k2", "k3"];
  const first = await inTransaction(() => Promise.resolve(), undefined, {
    keys,
  });
  expect(first.outcome?.kind).toBe("ran");
  const coordination = join(first.root, "coordination");
  const files = readdirSync(coordination)
    .filter((name) => name.startsWith("k-"))
    .sort();
  expect(files.length).toBe(3);
  const last = join(coordination, files.at(-1) ?? "");
  rmSync(last);
  writeFileSync(join(first.root, "..", "elsewhere.lock"), "");
  symlinkSync(join(first.root, "..", "elsewhere.lock"), last);
  const second = await inTransaction(() => Promise.resolve(), undefined, {
    keys,
    root: first.root,
  });
  expect(second.outcome?.kind).toBe("unavailable");
  expect(
    second.outcome?.kind === "unavailable" ? second.outcome.reason : "",
  ).toBe("coordination-failed");
  expect(lockFree(join(coordination, "admission.lock"))).toBe(true);
  for (const name of files.slice(0, -1))
    expect(lockFree(join(coordination, name))).toBe(true);
  expect(readOperations(first.root).length).toBe(1);
});

caseTest("C01.k-self-check-decision", async () => {
  const verdict = (returned: number, errno: number | undefined) => {
    const calls: { fd: number; operation: number }[] = [];
    const route = checkedFlock("test-library", {
      flock: (fd, operation) => {
        calls.push({ fd, operation });
        return returned;
      },
      errno: () => errno,
    });
    expect(calls).toEqual([{ fd: -1, operation: 6 }]);
    return route.ok ? "accepted" : route.step;
  };
  expect(verdict(-1, 9)).toBe("accepted");
  expect(verdict(0, 9)).toBe("flock(-1) returned 0, expected -1 with EBADF");
  expect(verdict(0, undefined)).toBe(
    "flock(-1) returned 0, expected -1 with EBADF",
  );
  for (const [errno, word] of [
    [11, "EAGAIN"],
    [22, "EINVAL"],
    [37, "ENOLCK"],
    [38, "ENOSYS"],
    [95, "EOPNOTSUPP"],
    [0, "errno-0"],
  ] as const)
    expect(verdict(-1, errno)).toBe(
      `flock(-1) returned -1 with ${word}, expected -1 with EBADF`,
    );
  expect(verdict(-1, undefined)).toBe(
    "flock(-1) returned -1 with an unreadable error code, expected -1 with EBADF",
  );

  let next: { returned: number; errno: number | undefined } = {
    returned: -1,
    errno: 9,
  };
  const route = checkedFlock("test-library", {
    flock: () => next.returned,
    errno: () => next.errno,
  });
  if (!route.ok) throw new Error("The self-check refused a valid binding.");
  next = { returned: 0, errno: undefined };
  expect(route.lock(5)).toEqual({ kind: "held" });
  next = { returned: -1, errno: 11 };
  expect(route.lock(5)).toEqual({ kind: "busy" });
  next = { returned: -1, errno: 22 };
  expect(route.lock(5)).toEqual({ kind: "failed", code: "EINVAL" });
  next = { returned: -1, errno: undefined };
  expect(route.lock(5)).toEqual({
    kind: "failed",
    code: "an unreadable error code",
  });
  await Promise.resolve();
});

const waitMessage =
  "The state add-on factory option admissionWaitMilliseconds must be a number of milliseconds, or left unset for the default of 2000.";
function refusedAtConstruction(value: unknown): void {
  const root = join(temporaryRoot("c3-state-wait-"), "state");
  const options = { root, report: "cx.pending" };
  Reflect.set(options, "admissionWaitMilliseconds", value);
  const build = () => stateAddon(options);
  expect(build).toThrow(TypeError);
  expect(build).toThrow(waitMessage);
  expect(existsSync(root)).toBe(false);
}

test("NW.a a NaN wait limit is refused when the add-on is built", () => {
  refusedAtConstruction(Number.NaN);
  refusedAtConstruction(Number(undefined));
});

test("NW.b a wait limit that is not a number is refused, not coerced", () => {
  for (const value of ["5000", {}, null]) refusedAtConstruction(value);
});

test("NW.c an absent wait limit is accepted", () => {
  const root = join(temporaryRoot("c3-state-wait-"), "state");
  expect(() => stateAddon({ root, report: "cx.pending" })).not.toThrow();
  expect(existsSync(root)).toBe(false);
});

test("NW.f a finite wait limit inside the range is accepted", () => {
  const root = join(temporaryRoot("c3-state-wait-"), "state");
  expect(() =>
    stateAddon({ root, report: "cx.pending", admissionWaitMilliseconds: 250 }),
  ).not.toThrow();
  expect(existsSync(root)).toBe(false);
});
